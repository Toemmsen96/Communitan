// Shared source (linked into Communitan.csproj and referee/Referee.csproj): docs/design/game-modes.md.
// A server-defined game mode as the rules code needs it. The server sends the resolved definition
// (server/data/modes/<id>.json) as ccsModeDef; each host parses that JSON itself (mod: Newtonsoft, referee: System.Text.Json)
// and fills this POCO, so this file has no JSON dependency.
namespace Communitan.Rules
{
    public sealed class ModeDef
    {
        public string Id = "";
        public string Name = "";
        // rules.dice.fixedSum: every roll has this sum (2..12); null = normal dice
        public int? DiceFixedSum;
        // rules.roundGrant.count: random base resources each player gets at the start of every round (0 = off)
        public int RoundGrant;

        // Clamps/clears out-of-range switches; returns false when nothing is left to do (mode without rule switches).
        public bool Normalize()
        {
            if (DiceFixedSum.HasValue && (DiceFixedSum.Value < 2 || DiceFixedSum.Value > 12))
            {
                DiceFixedSum = null;
            }
            if (RoundGrant < 0 || RoundGrant > 20)
            {
                RoundGrant = 0;
            }
            return DiceFixedSum.HasValue || RoundGrant > 0;
        }

        public override string ToString()
        {
            return $"{Id} (dice.fixedSum={(DiceFixedSum.HasValue ? DiceFixedSum.Value.ToString() : "-")}, roundGrant.count={RoundGrant})";
        }
    }
}
