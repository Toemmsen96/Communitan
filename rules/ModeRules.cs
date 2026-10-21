// Shared source (linked into Communitan.csproj and referee/Referee.csproj): docs/design/game-modes.md.
// Rule switches of server-defined game modes, implemented once for every client (lockstep: all clients run the rules)
// and the L3 referee. Static Current = the mode of the one game this process runs (null = no mode); the mod narrows it
// to the running challenge with Gate. Only Harmony APIs common to HarmonyX (mod) and Lib.Harmony (referee) are used.
//   dice.fixedSum    BaseRollDiceRule.GenerateDiceState postfix: both dice from CreateDiceRNG(NextUniqueId) (the game's
//                    own roll seed), d1 uniform over the values that leave a valid d2 = sum - d1
//   roundGrant.count ActionContextTransitions.CallEnterContextAction postfix: entering Base_TurnEnded from a "next player"
//                    context with the start player active (= a new round) appends one System Base_DistributeResources
//                    action, `count` random base resources per player (RNG CreateRNG(0x4D4F4445 ^ TurnNumber))
using System;
using System.Collections.Generic;
using System.Reflection;
using Catan.GameLogic.Model;
using Catan.GameLogic.Queries;
using Catan.GameLogic.Rules;
using Catan.GameLogic.Utilities;
using Common.GameLogic.Actions;
using Common.GameLogic.Model;
using HarmonyLib;

namespace Communitan.Rules
{
    public static class ModeRules
    {
        // Mode of the game this process runs (null = none). Mod: set from the server's ccsModeDef; referee: per replay.
        public static ModeDef Current;
        // Optional extra condition (mod: only while that challenge is the running online game, custom servers only).
        public static Func<bool> Gate;
        // Optional diagnostics sink (mod: harness/verbose only).
        public static Action<string> Log;
        public static int Rolls, Grants; // switch applications since the last reset (diagnostics / tests)
        public static bool Patched { get; private set; }

        private const int GrantVariant = 0x4D4F4445; // "MODE"
        private static readonly BaseResourceType[] BaseResources = { BaseResourceType.Lumber, BaseResourceType.Brick, BaseResourceType.Wool, BaseResourceType.Grain, BaseResourceType.Ore };

        public static ModeDef Active
        {
            get
            {
                ModeDef m = Current;
                Func<bool> g = Gate;
                return m != null && (g == null || g()) ? m : null;
            }
        }

        // Throws when a target is missing (game version change): the host must then refuse mode games.
        public static void Patch(Harmony harmony)
        {
            if (Patched)
            {
                return;
            }
            MethodBase dice = AccessTools.Method(typeof(BaseRollDiceRule), nameof(BaseRollDiceRule.GenerateDiceState))
                ?? throw new MissingMethodException("BaseRollDiceRule.GenerateDiceState");
            MethodBase enter = AccessTools.Method(typeof(ActionContextTransitions), nameof(ActionContextTransitions.CallEnterContextAction))
                ?? throw new MissingMethodException("ActionContextTransitions.CallEnterContextAction");
            harmony.Patch(dice, postfix: new HarmonyMethod(AccessTools.Method(typeof(ModeRules), nameof(FixedDice))));
            harmony.Patch(enter, postfix: new HarmonyMethod(AccessTools.Method(typeof(ModeRules), nameof(RoundGrant))));
            Patched = true;
        }

        // ---- dice.fixedSum ----
        private static void FixedDice(CommonGameState gameState, Base_RollDice_GameActionState __result)
        {
            ModeDef m = Active;
            if (m == null || !m.DiceFixedSum.HasValue || __result == null || gameState == null)
            {
                return;
            }
            int sum = m.DiceFixedSum.Value;
            int lo = Math.Max(1, sum - 6), hi = Math.Min(6, sum - 1);
            if (lo > hi)
            {
                return;
            }
            FastRandom rng = gameState.CreateDiceRNG(gameState.ContextState?.NextUniqueId.GetValueOrDefault(0) ?? 0);
            int d1 = rng.Next(lo, hi + 1);
            __result.DiceValues = new List<int> { d1, sum - d1 };
            Rolls++;
        }

        // ---- roundGrant.count ----
        private static void RoundGrant(CommonContextId from, CommonContextId to, CommonGameState gameState)
        {
            ModeDef m = Active;
            CatanGameState cgs = gameState?.CatanGameState;
            if (m == null || m.RoundGrant <= 0 || cgs?.Match == null || cgs.Player == null || gameState.ContextState == null || CatanGameUtils.IsBigGame(cgs))
            {
                return;
            }
            // A new round: the start player's turn begins (Base_NextPlayer -> Base_TurnEnded, or the first turn after the start
            // phase). Other ways into Base_TurnEnded (dev card played before rolling) return to the same turn: no grant.
            if (to == null || !to.Equals(CommonContextId.AsCatanId(CatanGameActionContextId.Base_TurnEnded)) || from == null
                || !(from.Equals(CommonContextId.AsCatanId(CatanGameActionContextId.Base_NextPlayer)) || from.Equals(CommonContextId.AsCatanId(CatanGameActionContextId.Base_StartPhase_NextPlayer)))
                || cgs.Match.GetActivePlayerId(cgs) != cgs.Match.StartPlayerId)
            {
                return;
            }
            FastRandom rng = gameState.CreateRNG(GrantVariant ^ cgs.Match.TurnNumber);
            Dictionary<HexGridPosition, Dictionary<int, CardBundleModel>> grants = new Dictionary<HexGridPosition, Dictionary<int, CardBundleModel>>();
            List<string> log = Log != null ? new List<string>() : null;
            for (int p = 0; p < cgs.Player.Count; p++)
            {
                CardBundleModel bundle = CardBundleModel.CreateEmpty();
                List<string> names = log != null ? new List<string>() : null;
                for (int k = 0; k < m.RoundGrant; k++)
                {
                    BaseResourceType t = BaseResources[rng.Next(BaseResources.Length)];
                    bundle.AddAmount(t, 1);
                    names?.Add(t.ToString());
                }
                // Key = a resource tile next to one of the player's buildings (log line + card animation start there); Apply
                // only reads player + cards.
                HexGridPosition key = KeyFor(cgs, p);
                if (key == null)
                {
                    continue;
                }
                if (!grants.TryGetValue(key, out Dictionary<int, CardBundleModel> perPlayer))
                {
                    perPlayer = new Dictionary<int, CardBundleModel>();
                    grants.Add(key, perPlayer);
                }
                perPlayer[p] = bundle;
                log?.Add($"p{p}=[{string.Join(",", names.ToArray())}]");
            }
            if (grants.Count == 0)
            {
                return;
            }
            CommonGameActionState action = CommonGameActionState.CreateCatanAction(CatanGameActionId.Base_DistributeResources);
            action.PlayerId = cgs.Match.GetActivePlayerIdOverall(cgs);
            action.CatanGameActionState.AsResourceDistribution = ResourceDistribution_GameActionState.CreateEmpty();
            action.CatanGameActionState.AsResourceDistribution.ResourcesPerPlayerPerTile = grants;
            // ActionContext.Generate (runs right after this) adds the context's own actions and numbers them all
            gameState.ContextState.SystemActions.Add(action);
            Grants++;
            Log?.Invoke($"round grant turn={cgs.Match.TurnNumber} next={gameState.ContextState.NextUniqueId}: {string.Join(" ", log.ToArray())}");
        }

        private static HexGridPosition KeyFor(CatanGameState cgs, int player)
        {
            FacePosition best = null;
            foreach (PositionedGamePiece b in BoardQuery.GetAllBuildingsByPlayer(cgs, player))
            {
                if (b?.Position?.AsCornerPos == null)
                {
                    continue;
                }
                foreach (HexGridPosition face in b.Position.AsCornerPos)
                {
                    FacePosition f = face?.AsFacePos;
                    PositionedGamePiece tile = f != null ? BoardQuery.GetTileAt(f, cgs) : null;
                    if (tile?.Piece?.AsTile == null || !BaseDistributeResourcesRule.ResourceTypeForTile(tile.Piece.AsTile.Type).HasValue)
                    {
                        continue;
                    }
                    if (best == null || f.X < best.X || (f.X == best.X && f.Y < best.Y))
                    {
                        best = f; // smallest position: independent of dictionary order
                    }
                }
            }
            if (best == null)
            {
                best = BoardQuery.GetRobberTile(cgs)?.Position?.AsFacePos;
            }
            return best != null ? new HexGridPosition(best) : null;
        }
    }
}
