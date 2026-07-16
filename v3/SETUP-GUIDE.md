# Trading Bot (V3) — Setup Guide (start to finish)

This bot receives your TradingView alerts and places the trades in Tradovate for
you, rotating through your prop accounts one trade at a time. You run it on your
own Windows computer. Plan for about 45–60 minutes the first time. No tech
skills needed — just follow each step in order and don't skip ahead.

**This is V3** — the self-healing version. On top of the trading, it:
- **reconnects and logs back into Tradovate by itself** after a restart,
- **clears Tradovate popups on its own** (and every ~45s while running),
- **notices if it gets logged out** and tries to fix it before a trade is missed,
- **restarts itself** if it ever crashes,
- **texts your phone** only when you're actually needed, or when you win.

It runs on **port 3400** (V2, if you also have it, uses 3300 — they don't clash).

## ⚠️ Three rules before you start

1. **Make your OWN keys.** You'll create your own "secret," your own ngrok
   address, and (optionally) your own Telegram bot. Never copy someone else's —
   whoever's address+secret is in your TradingView alert is whose accounts get
   traded.
2. **The bot starts in Practice mode** (no real orders). Keep it there until
   everything is tested. Live mode is a deliberate switch with a big warning.
3. **Know the risk.** Prop firms generally don't allow automation — running this
   can violate their terms and could get an account closed. Run it only if you
   understand and accept that.

## What you need before starting

- A Windows computer that can stay on 24/7 while you trade (8GB+ memory)
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
`node -v` and press Enter. If you see a version number like `v22…`/`v24…`, good.

## Part 2 — Download the bot

1. Sign in at **github.com**, then open the bot's repository page (from your
   invite): `github.com/undacovacobra/tradestation`
2. **Important:** near the top-left there's a branch button (probably says
   `main`). Click it and choose **`claude/tradestation-takeover-qowymb`**. After
   picking it you should see a **`v3`** folder in the file list. If you don't
   see `v3`, you're on the wrong branch.
3. Click the green **`< > Code`** button → **Download ZIP**.
4. In your Downloads, right-click the ZIP → **Extract All → Extract**.
5. Open the extracted folder, find the **`v3`** folder, and move it somewhere
   permanent like **Documents** (cut + paste, not copy; don't leave it in
   Downloads).

## Part 3 — Install the bot's pieces

1. Open the **`v3`** folder in File Explorer.
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

## Part 5 — (Optional but recommended) Phone alerts via Telegram

Skip this the first time if you like — everything works without it. To turn it
on:

1. On your phone, install **Telegram** and make an account.
2. Search **@BotFather**, tap Start, send **`/newbot`**, and answer its two
   questions (a name, then a username ending in `bot`). It replies with a
   **token** — copy it.
3. Open **your** new bot (the username you just made), tap Start, send it `hi`.
4. On a computer, visit this address (replace `<TOKEN>` with your token):
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   Find `"chat":{"id":` followed by a number — that's your **chat id**.

## Part 6 — Create your settings file

1. In the black command window (still in the `v3` folder), type:

   ```
   notepad .env
   ```

   Say **Yes** if it asks to create the file.
2. Type these lines, using YOUR values from Parts 4–5 (no `<` `>` brackets, no
   quotes). Leave out the two Telegram lines if you skipped Part 5:

   ```
   WEBHOOK_SECRET=your-own-long-random-secret
   DASHBOARD_PASSWORD=your-dashboard-password
   NGROK_AUTHTOKEN=your-ngrok-authtoken
   NGROK_DOMAIN=your-words-here.ngrok-free.dev
   AUTO_CONNECT=true
   NGROK_AUTOSTART=true
   TELEGRAM_BOT_TOKEN=your-telegram-token
   TELEGRAM_CHAT_ID=your-chat-id
   ```

   (`AUTO_CONNECT=true` + `NGROK_AUTOSTART=true` are what make it start
   *everything* by itself — the Tradovate browser and remote access — after a
   restart. Leave them on for a live machine.)
3. **File → Save**, then close Notepad.

## Part 7 — Start it and log into Tradovate

1. In the black window, type:

   ```
   npm start
   ```

   You should see lines ending with
   `Dashboard + webhooks listening on http://localhost:3400`.
   **Leave this window open — it IS the bot.**
2. Open a web browser and go to **http://localhost:3400** — enter your
   dashboard password.
3. Because `AUTO_CONNECT=true`, a Tradovate browser window opens by itself. The
   first time, **log into Tradovate there** (username, password, 2FA). It
   remembers you afterward, so future restarts log in on their own.
4. Back on the dashboard, the **Tradovate** pill should turn green
   (**"logged in"**) and **Remote access** should go green on its own.
   - If Remote access shows a problem, make sure **no other computer** is using
     the same ngrok address — only one machine can hold it at a time.

## Part 8 — Add your accounts

Before scanning, use the **Tradovate logins** card to add each saved session.
Give it a friendly name and prop-firm name, click Connect, and complete login/2FA
once. Accounts under one prop-firm username can share a saved login; different
prop-firm usernames need different saved logins.

Use one saved session for all Evaluation and Funded accounts under the same
Tradovate username. Add another saved login only for a different username or
prop firm. One Tradovate window safely switches between its assigned accounts;
Funded work is prioritized whenever Funded and Evaluation work arrive together.

1. In the Tradovate logins card, click **Scan accounts** beside the login you
   want to scan. It reads that login's accounts automatically.
2. Tick which accounts are **Evals** (ids starting LFE) and which are **Funded**
   (LFF) — it pre-guesses — then add them.
3. Use the arrows to set the order they're traded in. The one marked **NEXT**
   takes the next trade.

## Part 9 — Connect TradingView

1. In TradingView, open the chart with your strategy and create an **Alert** on
   the strategy.
2. Tick **Webhook URL** and enter (using YOUR domain):

   ```
   https://your-words-here.ngrok-free.dev/webhook/evals
   ```

   (`/webhook/evals` trades evals; `/webhook/funded` trades funded. Use one per
   lane when quantities differ. Use `/webhook` to send the same signal and
   quantity to both lanes concurrently.)
3. Paste this in the alert **Message** box, replacing the secret with YOUR
   secret:

   ```json
   {
     "secret": "your-own-long-random-secret",
     "action": "{{strategy.order.action}}",
     "symbol": "{{ticker}}",
     "quantity": {{strategy.order.contracts}},
     "marketPosition": "{{strategy.market_position}}"
   }
   ```

   The `quantity` line has no quotes around its value — leave it exactly like
   that. One alert handles both opening and closing.
4. Set the alert to **Open-ended** and create it.

## Part 10 — Test before anything is real

1. Stay in **Practice mode** (the default).
2. Fire a test alert from TradingView (or wait for your strategy to trigger).
3. Watch the **Activity** feed at the bottom of the dashboard. You should see a
   line like *"PRACTICE — would BUY 2x … No real order placed."* That proves the
   whole chain works: TradingView → internet → your bot.
4. Click **Test position reader**. Watch Tradovate switch to Funded first and
   then Evaluation. The result must show the verified account and `FLAT (0)` or
   `OPEN (+/-N)`. This test never clicks Buy, Sell, Exit, or the ATM control.
5. Try **Test size** and **Test ATM preset** too. They change only the tested
   control and do not place an order.
6. Only when practice looks right, click **"Switch to LIVE"** — and start with
   the smallest size.

## Daily use

- Double-click **`Start Trading Bot.cmd`** in the `v3` folder to start
  everything (bot + dashboard, and — with `AUTO_CONNECT`/`NGROK_AUTOSTART` on —
  the Tradovate browser and remote access too). Right-click it →
  **Send to → Desktop** to make a one-tap desktop shortcut.
- If the bot ever crashes, it restarts itself within 5 seconds.
- Check the dashboard from your phone anytime at your ngrok address
  (`https://your-words-here.ngrok-free.dev`).
- **Run the bot on ONE computer only.** Your ngrok address can only be held by
  one machine at a time.
- Keep the computer plugged in and set Windows to **never sleep**
  (Settings → System → Power).

## When will my phone buzz?

Only when it matters:
- **🔴 NEEDS YOU** — a trade didn't go through, a popup is stuck, Tradovate needs
  a login, or the computer restarted while a trade was open.
- **🏅 Good news** — you won a trade, or an account hit the target and passed.
- Everything routine (normal trades, popups it cleared itself, clean restarts)
  stays silent — it's all still in the dashboard's Activity feed.

## If something looks wrong

- **Bot window closed / computer restarted:** double-click
  `Start Trading Bot.cmd` again; with auto-connect on it comes back by itself.
- **"Tradovate: not logged in":** click **Connect browser** and finish the
  login in the window that opens.
- **Alert didn't fire:** check the Activity feed. "Wrong secret" means the
  secret in your TradingView message doesn't exactly match your `.env`. Nothing
  at all means TradingView couldn't reach you — check the Remote access pill is
  green and the webhook URL uses your ngrok domain (never "localhost").
- **Bot thinks a trade is open but it isn't:** click **"✖ Mark closed /
  reset"** next to the open-trade banner (it only fixes the bot's memory — it
  never places or closes real orders).
