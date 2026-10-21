using Common.Net;
using HarmonyLib;
using System.Collections.Generic;
using System.Reflection;
using System.Reflection.Emit;

namespace Communitan
{
    // GameLogicWaitState.RetryPlayerSetupReady gives up 20 s after the local SETUP_READY if GAME_START_GAMELOGIC hasn't come
    // (all players ready), then the client leaves the match. A fast loader (e.g. a headless bot, 8 s) therefore drops out
    // whenever another player needs >20 s longer to load (a full client: ~35 s). Custom servers: wait longer.
    [HarmonyPatch]
    internal static class GameLogicWait
    {
        private const float CustomServerWait = 120f;

        private static MethodBase TargetMethod()
        {
            return AccessTools.EnumeratorMoveNext(AccessTools.Method(typeof(GameLogicWaitState), "RetryPlayerSetupReady"));
        }

        private static IEnumerable<CodeInstruction> Transpiler(IEnumerable<CodeInstruction> instructions)
        {
            int replaced = 0;
            foreach (CodeInstruction ins in instructions)
            {
                if (ins.opcode == OpCodes.Ldc_R4 && ins.operand is float f && f == GameLogicWaitState.WAIT_FOR_GAMELOGIC_DELAY)
                {
                    replaced++;
                    yield return new CodeInstruction(OpCodes.Call, AccessTools.Method(typeof(GameLogicWait), nameof(Delay)));
                    continue;
                }
                yield return ins;
            }
            if (replaced != 1)
            {
                Communitan.logger.LogWarning($"GameLogicWait: expected 1 wait constant, replaced {replaced}");
            }
        }

        private static float Delay()
        {
            return ServerList.IsCustomSelected ? CustomServerWait : GameLogicWaitState.WAIT_FOR_GAMELOGIC_DELAY;
        }
    }
}
