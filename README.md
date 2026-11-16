# Table Stakes

Virtual chips for real card nights. You play poker or blackjack with physical cards at a real table; the app keeps
everyone's stack, the bets and the pots in sync across all phones. One person hosts a table, the others join with a
four-digit code, a link or a QR code.

The app never deals cards and never moves money. It only keeps count.

## What it does

**Poker (no-limit hold'em)**
- Dealer button and blinds move automatically; turn order is enforced.
- Fold, check, call, bet/raise (slider, pot-fraction buttons, +/−) and all-in, with correct minimum raises.
- Main pot and side pots are calculated automatically; uncalled bets go straight back.
- At showdown the host taps the winner (or several, for a split pot). If the host allows it, a winner can take the pot from their own phone.
- The host can act for a player whose phone died, cancel a misdealt hand, and undo the last action.

**Blackjack**
- Each player places a bet per round with a slider and quick-chip buttons; double and split are supported.
- The dealer closes the bets, deals the real cards and settles each hand with one tap: Win (1:1), Blackjack (3:2 or 6:5), Push or Lose — or settles all remaining hands at once.
- The bank is either a running "house" tally or the dealer's own stack.

**Chips in and out**
- Type an amount to add chips (the host approves buy-ins by default).
- Or scan what is on the table with the camera: physical chips (by colour), euro or pound coins (by size and metal colour) and banknotes (by colour). Counts can always be corrected before anything is added — see *The scanner* below.
- A ledger shows buy-ins, stacks and each player's result for settling up afterwards.

**Phones being phones**
- If a screen locks or the connection drops, the seat is kept and the phone rejoins by itself when it wakes up.
- Joining again with the same name takes back an offline seat (dead battery, borrowed phone).
- If the host disappears, another player can take over after 20 seconds.
- If the server restarts, the host's phone restores the whole table from its own backup.

## Run it on your computer

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open `http://localhost:3000`. Phones on the same Wi-Fi can use the address printed in the terminal
(`http://192.168.x.x:3000`).

Browsers only allow **live camera access over HTTPS**. Over plain `http://` on your Wi-Fi everything works except the
live camera preview; the scanner then offers "Take a photo", which is counted the same way. For the live preview either
deploy the app (below) or run

```bash
npm run https
```

which serves over HTTPS with a self-signed certificate (each phone shows a one-time warning to accept).

## Deploy to Render

The repository contains a `render.yaml` Blueprint, so there is nothing to configure.

1. Push this repository to GitHub.
2. In the Render dashboard choose **New → Blueprint**, connect your GitHub account and pick the repository.
3. Confirm. Render runs `npm ci --omit=dev`, starts `node server.js` and checks `/healthz`.

You get an `https://…onrender.com` address, so the live camera scanner works on every phone.

Good to know about Render's **free plan**:

- The service goes to sleep after 15 minutes without traffic and takes about a minute to wake up. While phones are
  connected their heartbeats count as traffic, so a table in play stays awake.
- The disk is not persistent and tables live in memory. If the service does restart (sleep, redeploy), the host's phone
  re-creates the table from its backup as soon as it reconnects, and everyone else is seated again automatically.
- For a table that never sleeps, switch `plan: free` to a paid plan in `render.yaml`.

Any other Node host works the same way: it must support WebSockets and set the `PORT` environment variable.

## The scanner

Everything runs on the phone in plain JavaScript on a canvas; no image leaves the device.

- **Circles** (chips and coins) are found with a Hough-gradient circle transform. Edges come from whichever colour
  channel changes most, so a red chip on green felt is found even though the brightness is the same.
- **Chips** are grouped by the dominant colour of their face (coarse hue histogram, then clustering). You set what each
  colour is worth once; the phone remembers it.
- **Coins** have no ruler next to them, so the scale is the one that makes all coins in the picture fit real coin
  diameters best, with the metal colour (copper, gold, silver, two-tone) as a second clue. That needs at least two
  different coins; a single coin is flagged instead of guessed.
- **Banknotes** are found as large rectangles that differ from the table colour and are told apart by colour (and by
  length when coins in the same picture give a scale).

It is an aid, not a cash-counting machine. Lay everything flat, side by side and not overlapping, on a plain surface,
with even light, and hold the phone straight above. The result is always shown as an editable count — tap a piece to
leave it out, use +/− to correct, or skip the camera and count by hand — and with host approval switched on the host
sees what was scanned before it is added.

The detection code is tested against synthetic table images (`test/scanner.test.js`); it has not been calibrated
against a large set of real photos, so expect to correct a count now and then, especially in poor light.

## Tests

```bash
npm test
```

- `test/engine.test.js` — poker and blackjack rules, side pots, undo, and a randomised run that checks chips are never created or lost.
- `test/socket.test.js` — several clients at one table over real sockets: joining, turn order, reconnecting, restoring after a restart.
- `test/scanner.test.js` — the vision code on generated chips, euro/pound coins and banknotes.

## Project layout

```
server.js              Express + Socket.io wiring, QR endpoint, health check
src/rooms.js           Tables, seats, buy-ins, host tools, action dispatcher, backup/restore
src/poker.js           Betting engine: button, blinds, turns, side pots, payouts
src/blackjack.js       Bets, double/split, settlement, bank
public/index.html      Single page
public/js/app.js       Client: screens, betting dock, menus, reconnection
public/js/scanner.js   Camera/photo UI for the scanner
public/js/scanner-cv.js  Circle transform, banknote detection, classification
public/css/style.css   Styles
render.yaml            Render Blueprint
```

Fonts: DM Serif Display and Barlow Semi Condensed, both under the SIL Open Font License, bundled in `public/fonts`.
