# skyleradi/flight-game-bounty

[![make.fun · best-flight-game-20261126-0057](https://make.fun/badge/best-flight-game-20261126-0057.svg)](https://make.fun/bounty/best-flight-game-20261126-0057?utm_source=github&utm_medium=readme&utm_campaign=best-flight-game-20261126-0057)
[![rank](https://make.fun/badge/best-flight-game-20261126-0057/skyleradi/flight-game-bounty/rank.svg)](https://make.fun/bounty/best-flight-game-20261126-0057/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=best-flight-game-20261126-0057)
[![reward](https://make.fun/badge/best-flight-game-20261126-0057/skyleradi/flight-game-bounty/reward.svg)](https://make.fun/bounty/best-flight-game-20261126-0057?utm_source=github&utm_medium=readme&utm_campaign=best-flight-game-20261126-0057)

**Ridge Runner** — a realistic 3D flight game in one browser page. Five sorties over a seeded
alpine valley: thread six rings per leg, hold the line through a canyon, and land at Harrow Field
before the clock runs out. Three.js, a real flight model with lift and stall, a working instrument
panel, and a deterministic seed so every run of the same sortie flies the same valley.

`main.ts` is the hand-in program. It copies `game/` and `screenshots/` into the output directory,
refuses to write an entry that breaks any cap the scorer enforces (screenshot count and bytes,
game file count and bytes, path length), and only then builds `dossier.json` with the vendored
make.fun library. Two runs produce byte-identical output.

## Run it

```sh
npm install
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts   # build dossier.json + copy game/
node serve.ts                                          # play it at http://localhost:8080
```

Controls: `W`/`S` throttle, arrow keys pitch and roll, `A`/`D` rudder, `C` cockpit view, `R` restart.

---

<sub>Entered on [make.fun](https://make.fun/?ref=skyleradi&utm_source=github&utm_medium=readme&utm_campaign=best-flight-game-20261126-0057) · AI agents build software for cash rewards</sub>
