# Trading Bot — Setup Guide (start to finish)

This bot receives your TradingView alerts and places the trades in Tradovate for
you, rotating through your prop accounts one trade at a time. You run it on your
own Windows computer. Plan for about 45–60 minutes the first time. No tech
skills needed — just follow each step in order and don't skip ahead.

## ⚠️ Three rules before you start

1. **Make your OWN keys.** Later you'll create your own "secret" and your own
   ngrok address. Never copy someone else's from a screenshot or document —
   whoever's address+secret is in your TradingView alert is whose accounts get
   traded.
2. **The bot starts in Practice mode** (no real orders). Keep it there until
   everything is tested. Live mode is a deliberate switch with a big red warning.
3. **Know the risk.** Prop firms generally don't allow automation — running this
   can violate their terms and could get an account closed. Run it only if you
   understand and accept that.

## What you need before starting

- A Windows computer that can stay on while you trade (8GB+ memory is plenty)
- Your Tradovate login (your prop-firm accounts)
- A TradingView plan that supports **webhooks** in alerts
- A free account at **ngrok.com** (you'll make one in Part 4)
- Access to the bot's GitHub page (the person who sent you this can invite you)

---

## Part 1 — Install Node (the engine the bot runs on)

1. Go to **nodejs.org** and click the big **Get Node.js / LTS** download button.
2. Open the downloaded file. Click **Next → Next → Install**, accepting all the
   defaults. (If it mentions "tools for native modules," leave it unchecked.)
3. Click **Finish**.

**Check it worked:** open the Start menu, type **PowerShell**, open it, type
`node -v` and press Enter. If you see a version number like `v24…`, you're good.

## Part 2 — Download the bot

1. Sign in at **github.com**, then open the bot's repository page (from your
   invite): `github.com/undacovacobra/tradestation`
2. **Important:** near the top-left there's a branch button (it probably says
   `main`). Click it and choose **`claude/tradestation-takeover-qowymb`** — the
   up-to-date version lives there. After picking it you should see a **`v2`**
   folder in the file list. If you don't see `v2`, you're on the wrong branch.
3. Click the green **`< > Code`** button → **Download ZIP**.
4. In your Downloads, right-click the ZIP → **Extract All → Extract**.
5. Open the extracted folder until you find the **`v2`** folder, and move the
   whole project folder somewhere permanent like **Documents** (cut + paste, not
   copy, and don't leave it in Downloads).

## Part 3 — Install the bot's pieces

1. Open the **`v2`** folder in File Explorer.
2. Click once in the **address bar** at the top, type **`cmd`**, press
   **Enter**. A black command window opens, already pointed at the right folder.
3. Type each of these, pressing Enter after each, letting each finish before the
   next (the first takes a minute or two):

   ```
   npm install
   ```
   ```
   npm install @ngrok/ngrok
   ```
   ```
   npx playwright install chromium
   ```

Keep this black window open — you'll use it again in a moment.

## Part 4 — Get your keys (ngrok + your own secret)

The bot needs an internet address so TradingView can reach your computer.
That's what ngrok provides — for free.

1. Go to **ngrok.com** and sign up (free).
2. In the ngrok dashboard, find **Your Authtoken** in the left menu and click
   **Copy**. Paste it somewhere temporary like Notepad.
3. Find **Domains** in the left menu and create/claim your **free domain**.
   You'll get an address like `your-words-here.ngrok-free.dev`. Note it down
   exactly.
4. Now invent your **secret**: a long random string only you know, like
   `horse-battery-7391-purple-staple`. Longer and weirder is better. Note it
   down — you'll paste this exact value into TradingView later.
5. Also pick a **dashboard password** (anything you'll remember).

## Part 5 — Create your settings file

1. In the black command window (still in the `v2` folder), type:

   ```
   notepad .env
   ```

   Say **Yes** if it asks to create the file.
2. Type these 4 lines, using YOUR values from Part 4 (no `<` or `>` brackets,
   no quotes):

   ```
   WEBHOOK_SECRET=your-own-long-random-secret
   DASHBOARD_PASSWORD=your-dashboard-password
   NGROK_AUTHTOKEN=your-ngrok-authtoken
   NGROK_DOMAIN=your-words-here.ngrok-free.dev
   ```

3. **File → Save**, then close Notepad.

## Part 6 — Start it and log into Tradovate

1. In the black window, type:

   ```
   npm start
   ```

   You should see lines ending with something like
   `Dashboard + webhooks listening on http://localhost:3300`.
   **Leave this window open — it IS the bot.** Closing it stops the bot.
2. Open a web browser and go to **http://localhost:3300** — enter your
   dashboard password.
3. Click **"Connect browser."** A separate browser window opens by itself and
   goes to Tradovate. **Log into Tradovate there** (username, password, 2FA).
   This is one-time — it remembers you afterward.
4. Back on the dashboard, the **Tradovate** pill should turn green:
   **"Tradovate: logged in."**
5. Click **"Turn on remote access."** The pill should go green:
   **"Remote access: on."** (If it errors, your ngrok token/domain in `.env`
   don't match — recheck Part 5.)

## Part 7 — Add your accounts

1. On the dashboard click **"Scan Tradovate accounts."** It reads your account
   list from Tradovate automatically.
2. Tick which accounts are **Evals** (ids starting LFE) and which are **Funded**
   (LFF) — it pre-guesses for you — then add them.
3. Use the arrows to set the order you want them traded in. The one marked
   **NEXT** takes the next trade.

## Part 8 — Connect TradingView

1. In TradingView, open the chart with your strategy and create an **Alert** on
   the strategy.
2. Tick **Webhook URL** and enter (using YOUR domain):

   ```
   https://your-words-here.ngrok-free.dev/webhook/evals
   ```

   (`/webhook/evals` trades your eval accounts; `/webhook/funded` trades your
   funded ones. Make one alert per lane you use.)
3. Paste this in the alert **Message** box, replacing the secret with YOUR
   secret from Part 4:

   ```json
   {
     "secret": "your-own-long-random-secret",
     "action": "{{strategy.order.action}}",
     "symbol": "{{ticker}}",
     "quantity": {{strategy.order.contracts}},
     "marketPosition": "{{strategy.market_position}}"
   }
   ```

   Note: the `quantity` line has no quotes around its value — leave it exactly
   like that. One alert handles both opening and closing.
4. Set the alert to **Open-ended** and create it.

## Part 9 — Test before anything is real

1. Stay in **Practice mode** (the default).
2. Fire a test alert from TradingView (or wait for your strategy to trigger).
3. Watch the **Activity** feed at the bottom of the dashboard. You should see a
   line like *"PRACTICE — would BUY 2x … No real order placed."* That proves the
   whole chain works: TradingView → internet → your bot.
4. Try the **⏱ Speed test** and **🔢 Test size** buttons too (Test size needs
   the Tradovate order ticket visible; it sets the size box without placing an
   order).
5. Only when practice looks right, click **"Switch to LIVE"** — and start with
   the smallest size.

## Daily use

- Double-click **`Start Trading Bot.cmd`** in the `v2` folder to start
  everything (bot + dashboard). Right-click it → **Send to → Desktop** to make
  a desktop shortcut.
- Check the dashboard from your phone anytime at your ngrok address
  (`https://your-words-here.ngrok-free.dev`).
- **Run the bot on ONE computer only.** Your ngrok address can only be held by
  one machine at a time.
- Keep the computer plugged in and set Windows to **never sleep**
  (Settings → System → Power).

## If something looks wrong

- **Bot window closed / computer restarted:** double-click
  `Start Trading Bot.cmd` again, then check the dashboard pills are green.
- **"Tradovate: not logged in":** click **Connect browser** and finish the
  login in the window that opens.
- **Alert didn't fire:** check the Activity feed. "Wrong secret" means the
  secret in your TradingView message doesn't exactly match your `.env`.
  Nothing at all means TradingView couldn't reach you — check the Remote
  access pill is green and the webhook URL uses your ngrok domain (never
  "localhost").
- **Bot thinks a trade is open but it isn't:** click **"✖ Mark closed /
  reset"** next to the open-trade banner (it only fixes the bot's memory — it
  never places or closes real orders).
