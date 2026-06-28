# Step F — Own-brand social credentials (manual setup)

MY:TIME's *own* social metrics use **official APIs** (not the public scrapers we
use for competitors). This is the one-time credential setup you do; once the
values are in `.env`, I'll build the collectors.

Accounts: `instagram.com/mytime.mk`, `facebook.com/mytimemk`,
`tiktok.com/@mytime.mk`.

---

## 1. Meta Graph API — Instagram + Facebook (the main one)

### Prerequisite
MY:TIME's Instagram must be a **Business or Creator** account **linked to the
MY:TIME Facebook Page**. Check in the Instagram app: *Settings → Account type →
Switch to Professional* (Business). Then link it to the `mytimemk` Page
(*Page → Settings → Linked accounts → Instagram*).

### Steps
1. Go to **developers.facebook.com** → log in with the account that **admins the
   MY:TIME Page** → *My Apps → Create App → "Business"*.
2. In the app: *Add Product →* add **Instagram Graph API** (and **Facebook
   Login** if prompted).
3. *App settings → Basic*: copy **App ID** and **App Secret**.
4. Open the **Graph API Explorer** (developers.facebook.com/tools/explorer),
   select your app, and **Generate Access Token** with these permissions:
   - `pages_show_list`, `pages_read_engagement`
   - `instagram_basic`, `instagram_manage_insights`
   - `read_insights`, `business_management`
5. **Exchange for a long-lived token** (60-day), then a **Page token** (which
   effectively doesn't expire while you stay admin). Quick way — in a terminal:
   ```bash
   # a) short-lived → long-lived user token
   curl "https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_TOKEN"
   # b) list pages + get the Page token (use the long-lived user token)
   curl "https://graph.facebook.com/v21.0/me/accounts?access_token=LONG_USER_TOKEN"
   # c) find the linked IG Business account id
   curl "https://graph.facebook.com/v21.0/PAGE_ID?fields=instagram_business_account&access_token=PAGE_TOKEN"
   ```
6. Note these four values:
   - **App ID**, **App Secret**
   - **Page access token** (from step 5b)
   - **Page ID** and **Instagram Business Account ID** (from 5b / 5c)

> Pulling your **own** Page/IG insights with an admin Page token works in the
> app's *Development* mode — you do **not** need full App Review for first-party
> data. (App Review is only needed to access other people's data.)

### `.env` values
```
META_APP_ID=...
META_APP_SECRET=...
META_ACCESS_TOKEN=...        # the Page access token from step 5b
META_PAGE_ID=...             # mytimemk Page id
META_IG_USER_ID=...          # linked Instagram Business account id
```

---

## 2. TikTok — own brand (decision needed)

TikTok's **official** API (TikTok for Developers) requires app registration and
approval and doesn't cleanly expose follower analytics. Two options — tell me
which you prefer:

- **(Recommended) Reuse the public scraper** for MY:TIME's own TikTok. It's your
  own public account, so this is fine, and it's zero extra setup — I just add
  `mytime` to the existing TikTok collector. Keeps TikTok numbers comparable
  with competitors (same source).
- **Official TikTok API** — only if you want to go through TikTok's developer
  app + approval process. More work, marginal benefit for follower/like counts.

No `.env` values needed for the recommended option.

---

## 3. Google APIs — only if applicable

The brief mentioned Google APIs for own-brand. That's relevant **only if MY:TIME
has a YouTube channel or a Google Business Profile** you want tracked — neither
is in the current target list. If you do:

- **YouTube**: a Google Cloud project + YouTube Data API key, and the channel ID.
- **Google Business Profile**: OAuth + the Business Profile API (heavier).

Tell me the property (channel URL / GBP) and I'll add a collector + the needed
env vars. Otherwise we skip Google.

---

## When you're done
Drop the Meta values into `C:\Users\DRAGAN.SALDJIEV\mytime-bi\.env`, tell me your
TikTok choice and whether Google applies, and I'll build the own-brand collectors
(they write to the same `social_metrics` table, so MY:TIME appears right next to
competitors in `social_benchmark`).
