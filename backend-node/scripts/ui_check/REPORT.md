# kresker.com — local end-to-end browser check

**168 passed / 24 failed** (192 checks, run 2026-09-26 against the Node backend with the fake engine). Failures by kind: 10 missing UI, 5 bug, 2 dev server only, 2 bug (critical), 1 bug (safety), 1 bug (config-dependent), 1 security hardening, 1 bug (dev-only page), 1 privacy / retention.

Everything ran on this laptop: Node backend `backend-node/dist/main.js` on 127.0.0.1:8096 with a throwaway SQLite database (`backend/data/vn_ui_0926190147.db`, deleted afterwards), the Vite dev server on 127.0.0.1:5174, and Playwright 1.62.1 driving the cached Chromium 151 (plus one playback check in the installed Google Chrome 153). No request left the machine: the browsers ran behind a dead proxy and a "resolve nothing" host rule, and every non-local request was aborted and logged. The only host a page tried to reach was `pub-ecadf7ff6f844029a4030f2afadfb990.r2.dev` (the landing-page demo videos), and those requests were blocked.

## How it was run

Backend started exactly as specified (`VS_ENGINE_MODE=fake`, file mail, `VS_R2_ENABLED=0`, `VS_GPU_AUTO=0`, missing Dodo/Google env files, `VS_COOKIE_INSECURE=1`, `VS_PUBLIC_BASE_URL=http://127.0.0.1:5174`, `VS_FFPROBE=…`), plus four additions for safety, all local-only:

| Addition | Why |
|---|---|
| `C:\Program Files\Amazon\AWSCLIV2` removed from the backend's `PATH` (checked with `Get-Command aws` before `node` started) | The admin Overview and GPU pages run `aws ec2 describe-instances`, and "Force stop" runs `aws ec2 stop-instances` on the real GPU instance, even in fake mode (Problem 3). With the CLI on PATH that would have reached AWS. |
| `VS_AWS_PROFILE=ui_check_no_such_profile` | Second guard: a missing profile makes any AWS CLI call fail before it touches the network. |
| `VS_ENGINE_PORT=39199` | `engineAnswers()` probes `127.0.0.1:<port>/sysinfo`; 3900 is the SSH-tunnel port to the GPU box. Nothing listened on 3900, but a tunnel opened mid-run would have been reached. |
| `VS_EXPORT_ROOT=scripts/ui_check/_artifacts/export` | So "Write a migration archive" (which contains password hashes) landed in this folder and could be removed afterwards. |

Accounts: `ui-admin-0926190147@example.com` (first signup → admin), `ui-user-…` (regular customer), `ui-third-…` (grant / block / suspend target), `ui-contact-…` and `ui-rights-…` (contact and data-rights forms), `ui-prod-…`/`ui-prod2-…` (production-build check). Emails were read from `backend/data/mail/`.

Re-run: start the backend with a new stamp and the same variables **including the four additions above** (without them, the admin pages and "Force stop" make the backend call the real AWS CLI). Start Vite (`$env:VITE_BACKEND='http://127.0.0.1:8096'; npx vite --host 127.0.0.1 --port 5174 --strictPort`). Then, from this folder:

```
$env:UI_CHECK_AWS_GUARD='1'   # confirms the backend was started with the AWS guard
node run_all.js --stamp <MMddHHmmss> A B C1 D C2 C3 E ER E2 E3 X X2
node make_report.js
```

`run_all.js` refuses to run the admin areas (B, BR, D, PROD, X) unless `UI_CHECK_AWS_GUARD=1` is set. A new stamp resets `_state.json`, because the accounts it holds only exist in the old database.

`area_prod.js` additionally needs `npx vite build --outDir <this folder>\_prod_dist` and `npx vite preview --outDir <same> --host 127.0.0.1 --port 5175 --strictPort` (with `VITE_BACKEND` set). `BR` is the re-check of three B steps. Screenshots are in `shots/`, every row's raw data is in `results.json`, and every console/network event in `events.json`.

Rows marked "(re-check)" replace a first attempt that failed because of the test script (a lazy route checked too early, CSS-uppercased text, a missing `<main>`); the first attempts are listed in the appendix.

## Results

### A. Signed out — public pages — 58/58 passed

| # | Item | Result | Note |
|---|---|---|---|
| A1 | Privacy banner shows on first visit and "No analytics" dismisses it | PASS | banner shown, dismissed, stayed dismissed after reload; stored {"v":"2026-08-26.1-draft","analytics":false,"at":"2026-09-26T13:38:34.288Z"} (shots/001_A_banner.png) [demo-reel video request to the R2 host blocked by the test guard] |
| A2 | Privacy banner "That’s fine" (fresh visitor) records analytics=true; hidden on /privacy | PASS | hidden on /privacy; on /about accepted -> vs_privacy_ack.analytics=true |
| A3 | Page / (Landing) renders | PASS | HTTP 200; h1 "Your video, speaking every language"; title "Kresker — dub any video into any language"; 30 links, buttons: [Log in \| Start free \| Dub your first video free \| See how it works \| Play the demo \| Hindi original \| English \| Telugu \| Tamil \| Kannada \| Spanish \| Does it keep the original speaker’s voic \| Will the dub stay in sync with the pictu \| What happens if I close the browser mid- \| How long does a du… |
| A4 | Page /pricing (Pricing) renders | PASS | HTTP 200; h1 "Pay for minutes, not seats"; title "Pricing — pay for minutes, not seats \| Kresker"; 30 links, buttons: [Log in \| Start free \| Monthly \| Annual \| Choose Starter \| Choose Creator \| Choose Pro] (shots/003_A_page_pricing.png) |
| A5 | Page /languages (Languages) renders | PASS | HTTP 200; h1 "Every language Kresker dubs into"; title "All 43 dubbing languages \| Kresker"; 29 links, buttons: [Log in \| Start free \| Dub your first video free \| See pricing] (shots/004_A_page_languages.png) |
| A6 | Page /about (About) renders | PASS | HTTP 200; h1 "About Kresker"; title "About Kresker — who builds it and what it does"; 29 links, buttons: [Log in \| Start free] (shots/005_A_page_about.png) |
| A7 | Page /contact (Contact) renders | PASS | HTTP 200; h1 "Contact us"; title "Contact Kresker — support and enquiries"; 28 links, buttons: [Log in \| Start free \| General message \| Data rights request \| Send message] (shots/006_A_page_contact.png) |
| A8 | Page /privacy (Privacy) renders | PASS | HTTP 200; h1 "Privacy Notice"; title "Privacy Notice \| Kresker"; 31 links, buttons: [Log in \| Start free] (shots/007_A_page_privacy.png) |
| A9 | Page /terms (Terms) renders | PASS | HTTP 200; h1 "Terms of Service"; title "Terms of Service \| Kresker"; 31 links, buttons: [Log in \| Start free] (shots/008_A_page_terms.png) |
| A10 | Page /disclaimer (Disclaimer) renders | PASS | HTTP 200; h1 "Disclaimer"; title "Disclaimer \| Kresker"; 29 links, buttons: [Log in \| Start free] (shots/009_A_page_disclaimer.png) |
| A11 | Page /login (Login) renders | PASS | HTTP 200; h1 "Welcome back"; title "Kresker — dub any video into any language"; 3 links, buttons: [Sign in] (shots/010_A_page_login.png) |
| A12 | Page /signup (Signup) renders | PASS | HTTP 200; h1 "Create an account"; title "Kresker — dub any video into any language"; 5 links, buttons: [Sign up] (shots/011_A_page_signup.png) |
| A13 | Page /reset (Forgot password (/reset)) renders | PASS | HTTP 200; h1 "Reset your password"; title "Kresker — dub any video into any language"; 2 links, buttons: [Send the reset link] (shots/012_A_page_reset.png) |
| A14 | Page /verify (Verify email (no token)) renders | PASS | HTTP 200; h1 "Confirm your email"; title "Kresker — dub any video into any language"; 2 links, buttons: [Send me a new link] (shots/013_A_page_verify.png) |
| A15 | Unknown route shows the not-found page | PASS | 404 page with "There is nothing here"; "Back to the homepage" -> /; "Open the dashboard" -> /login?next=%2Fapp (shots/014_A_404.png) [demo-reel video request to the R2 host blocked by the test guard] |
| A16 | Header nav "Kresker home" (clicked from /pricing) | PASS | -> / [demo-reel video request to the R2 host blocked by the test guard] |
| A17 | Header nav "How it works" (clicked from /pricing) | PASS | -> /#how [demo-reel video request to the R2 host blocked by the test guard] |
| A18 | Header nav "Languages" (clicked from /pricing) | PASS | -> /languages |
| A19 | Header nav "Pricing" (clicked from /pricing) | PASS | -> /pricing |
| A20 | Header nav "Log in" (clicked from /pricing) | PASS | -> /login |
| A21 | Header nav "Start free" (clicked from /pricing) | PASS | -> /signup |
| A22 | Footer link "Kresker" -> / | PASS | -> / [demo-reel video request to the R2 host blocked by the test guard] |
| A23 | Footer link "How it works" -> /#how | PASS | -> /#how [demo-reel video request to the R2 host blocked by the test guard] |
| A24 | Footer link "All 43 languages" -> /languages | PASS | -> /languages |
| A25 | Footer link "Pricing" -> /pricing | PASS | -> /pricing |
| A26 | Footer link "FAQ" -> /#faq | PASS | -> /#faq [demo-reel video request to the R2 host blocked by the test guard] |
| A27 | Footer link "Log in" -> /login | PASS | -> /login |
| A28 | Footer link "Create an account" -> /signup | PASS | -> /signup |
| A29 | Footer link "Reset password" -> /reset | PASS | -> /reset |
| A30 | Footer link "Dashboard" -> /app | PASS | -> /login?next=%2Fapp |
| A31 | Footer link "About" -> /about | PASS | -> /about |
| A32 | Footer link "Contact us" -> /contact | PASS | -> /contact |
| A33 | Footer link "Privacy Notice" -> /privacy | PASS | -> /privacy |
| A34 | Footer link "Terms of Service" -> /terms | PASS | -> /terms |
| A35 | Footer link "Disclaimer" -> /disclaimer | PASS | -> /disclaimer |
| A36 | Footer link "Your data rights" -> /contact?kind=access | PASS | -> /contact?kind=access |
| A37 | Every internal link found on public pages resolves (no 404) | PASS | 14 distinct internal targets OK: / /languages /pricing /login /signup /reset /app /about /contact /privacy /terms /disclaimer /contact?kind=access /app/privacy [demo-reel video request to the R2 host blocked by the test guard] |
| A38 | External / mailto links inventory (not clicked, local-only rule) | PASS | mailto:NOT CONFIGURED ["NOT CONFIGURED" on /contact] |
| A39 | Landing: hero "Dub your first video free" -> /signup | PASS | ok [demo-reel video request to the R2 host blocked by the test guard] |
| A40 | Landing: "See how it works" scrolls to #how | PASS | hash=#how #how top=0px [demo-reel video request to the R2 host blocked by the test guard] |
| A41 | Landing: FAQ accordion items open and close | PASS | 6 FAQ items toggled (shots/015_A_faq.png) |
| A42 | Landing: demo reel "Play the demo" and "Demo language" buttons | PASS | video={"src":"https://pub-ecadf7ff6f844029a4030f2afadfb990.r2.dev/v1/demo/reel-hi.mp4","paused":true,"t":0,"err":4}; clicked 6 language buttons [Hindi original, English, Telugu, Tamil, Kannada, Spanish] (shots/016_A_demo.png) [demo-reel video request to the R2 host blocked by the test guard] |
| A43 | Landing: bottom CTA "Create an account" -> /signup | PASS | ok [demo-reel video request to the R2 host blocked by the test guard] |
| A44 | Pricing: cards match GET /api/billing/plans (monthly + annual) | PASS | open=true live=false; monthly: Starter ₹299 10min, Creator ₹999 50min, Pro ₹1,499 120min; annual: Starter (annual) ₹2,870 120min, Creator (annual) ₹9,590 600min, Pro (annual) ₹14,390 1440min (shots/017_A_pricing_month.png, shots/018_A_pricing_year.png) |
| A45 | Pricing: "Start free" and "Choose <plan>" buttons go to /signup | PASS | "Start free" -> /signup; "Choose Starter" -> /signup |
| A46 | Contact: short message is refused client-side | PASS | shows "A little more than that, please." for a 5-character message |
| A47 | Contact: mode tabs switch to "Data rights request" and back | PASS | rights kinds: Send me a copy of my data \| Correct something that is wrong \| Delete my data and close my account \| Withdraw a consent I gave \| Raise a grievance |
| A48 | Contact: submit a general message -> "Got it." + contact_ack mail | PASS | HTTP 200 id=1; page shows "Got it. Reference #1"; mail file 20260926-134020_000001_contact_ack_ui-contact-0926190147@example.com.txt (shots/019_A_contact_sent.png) |
| A49 | Contact: "Send another" resets the form, "Back to the site" -> / | PASS | form shown again after "Send another" |
| A50 | Login: wrong credentials show a non-enumerating error | PASS | error shown (shots/020_A_login_wrong.png) |
| A51 | Login: "Forgot your password?" -> /reset and "Create an account" -> /signup | PASS | both links work |
| A52 | Google sign-in button (not configured in this env) | PASS | google_auth=false; button visible=false; GET /api/auth/google/start -> 404 (sign-in NOT attempted, by rule) |
| A53 | Signup: short password shows "At least 8 characters." and blocks submit; legal links | PASS | error "At least 8 characters.", no request sent; legal links /terms, /privacy, /disclaimer; Terms link works |
| A54 | Forgot password: request for an unknown address shows the neutral confirmation | PASS | neutral message shown; "Back to sign in" works (shots/021_A_reset_sent.png) |
| A55 | Verify page: "Send me a new link" for an unknown address shows the neutral confirmation | PASS | neutral message shown |
| A56 | Signed-out /app, /app/billing, /app/admin and /dashboard redirect to /login | PASS | /app -> /login?next=%2Fapp; /app/billing -> /login?next=%2Fapp%2Fbilling; /app/admin -> /login?next=%2Fapp%2Fadmin; /dashboard -> /login?next=%2Fapp |
| A57 | /robots.txt and /sitemap.xml (proxied to the backend) | PASS | robots 200: "User-agent: * / Disallow: /"; sitemap 200 with 8 <loc> entries |
| A58 | Phone width (390px): "Open menu" shows the nav and its links work | PASS | menu opens, Pricing link works; horizontal overflow on /pricing = 0px (shots/022_A_phone_menu.png) [demo-reel video request to the R2 host blocked by the test guard] |

### B. Admin account and admin panel — 33/42 passed

| # | Item | Result | Note |
|---|---|---|---|
| B1 | Admin signup through the UI (first account) lands on the dashboard (re-check) | PASS | first signup (register 200, role=admin, auto-confirmed) went straight to /app; dashboard h1 "Dubbing", customer + admin nav all present; sidebar "1.00 of 1 min left" (shots/042_B_admin_dashboard.png) |
| B2 | Admin sign out (sidebar "Sign out") | PASS | -> /login?next=%2Fapp; /api/auth/me now 401 |
| B3 | Admin sign in again | PASS | signed in, back on /app |
| B4 | Overview page (/app/admin) (re-check) | PASS | all 8 stat cards present (Collected all time, Today, This week, Subscribers, Accounts, Signed in now, Jobs today, In flight); GPU card shows "AWS says unknown" because this run hid the AWS CLI from the backend (shots/043_B_overview_recheck.png) |
| B5 | Overview "Manage →" link -> /app/admin/gpu | PASS | ok |
| B6 | GPU page (/app/admin/gpu, nav "Capacity") renders | PASS | h1 "GPU box"; notice "Automatic lifecycle is off" shown; AWS says unknown; Engine URL http://127.0.0.1:3900 (shots/003_B_gpu.png) |
| B7 | GPU "Warm it up" (fake: harmless) | PASS | POST /api/admin/gpu/start -> 200 {"starting":true,"note":"warming up in the background; poll /api/admin/gpu. Held for 10 min from now unless work arrives"}; toast "Warming up warming up in the background; poll /api/admin/gpu. Held for 10 min from now unless work arrives" |
| B8 | GPU "Stop if idle" | PASS | -> 200 {"acted":false,"why":"auto lifecycle disabled"}; toast "Stop requested auto lifecycle disabled" |
| B9 | GPU "Force stop" — cancelling the confirm sends nothing (re-check) | PASS | confirm() shown ("Force stop ignores every safety condition…"), dismissed, no request sent |
| B10 | GPU "Force stop" — accepted (re-check) | **FAIL** (bug (safety)) | POST /api/admin/gpu/stop?force=true -> 200 {"forced":true,"was_holding":"last work finished at 2026-09-26T13:45:04Z, inside the 10 min idle window","rc":1}; toast "Force stopped" although rc=1 (nothing stopped). The handler calls the AWS CLI unconditionally (fake engine, VS_GPU_AUTO=0) - it could not reach AWS only because this run hid the aws CLI from the backend |
| B11 | People page: users table, audit, sessions | PASS | h1 "People"; columns [EMAIL, PLAN, MINUTES, DUBS, JOINED]; admin row "ui-admin-0926190147@example.com admin Free 0s used · 1.00 min left 0 26 Sept, 07:14 pm Grant plan Block buying"; audit: "Admin audit Append-only. This is how “why does this account have Pro without paying” stays answerable. gpu_force_stop 26 Sept, 07:15 pm ui-admin-0926190147@example.com — forced while: last work finished at 2026-09-26T13:"; sessi… |
| B12 | People: search by email | PASS | "ui-admin" -> 1 row(s); nonsense -> "No accounts match that"; cleared -> full list |
| B13 | Inbox: contact message from area A is listed with DPDP readiness card | PASS | h1 "Inbox"; header badges: 1 unanswered; DPDP setup is incomplete 5 of 6 checks are failing. Each one names its own fix. Action needed grievance contact pu (shots/005_B_inbox.png) |
| B14 | Inbox: open the message, check "Reply by email", mark it "Resolved" | PASS | reply href mailto:ui-contact-0926190147%40example.com?subject=Re%3A%20UI%20check%200926190147%20(%231); meta has "From IP": true; POST -> 200; toast "#1 marked resolved"; list now "Nothing here" (shots/006_B_inbox_resolved.png) |
| B15 | Inbox: filters "In progress", "Rights only", "Everything" | PASS | In progress: pressed=true "Nothing here"; Rights only: pressed=true "Nothing here"; Everything: pressed=true shows the message |
| B16 | System page: maintenance + SEO cards and the six tabs | PASS | h1 "System"; tabs [Storage, Outbox, Rate limits, Preset, Portability, Database]; SEO: Search engines Blocked; PUBLIC_BASE_URL is not https, so robots. (shots/007_B_system.png) |
| B17 | System tab "Storage" | PASS | aria-selected=true; Switched on no; Local output directory C:\video "Delivering from local disk local-disk downloads out of R2 are free at any volume, which is what makes unlimited downloads cost nothing beyond storage Credential" (shots/008_B_tab_Storage.png) |
| B18 | System tab "Outbox" | PASS | aria-selected=true; rows: 1; backend badge file "Outbox file from Kresker <no-reply@kresker.com> writing to disk; nothing is actually emailed Files land in C:\video translator\backend\data\mail. WHEN TO KIND S" (shots/009_B_tab_Outbox.png) |
| B19 | System tab "Rate limits" | PASS | aria-selected=true; e.g. login 10 per 5 min "What the rate limiter enforces per process, per key (IP or user id or email). moves behind the CDN in production; call sites do not change login 10 per 5 min re" (shots/010_B_tab_Rate_limits.png) |
| B20 | System tab "Preset" | PASS | aria-selected=true; "The pinned pipeline preset 2026-08-25.2-ui-confirmed Read-only on purpose. This is exactly what is sent to the engine, and its fingerprint is recorded on every " (shots/011_B_tab_Preset.png) |
| B21 | System tab "Portability" | PASS | aria-selected=true; "Could this move to another AWS account yes Write a migration archive schema 311c1468cae88e3d · 17 tables AWS identifiers are still built-in defaults these AWS i" (shots/012_B_tab_Portability.png) |
| B22 | System tab "Database" | PASS | aria-selected=true; "The database c:\video translator\backend\data\vn_ui_0926190147.db · 4 KB · SQLite (local development). Postgres in production - see the note in app/schema.sql a" (shots/013_B_tab_Database.png) |
| B23 | Portability: "Write a migration archive" | PASS | -> 200; toast "Archive written c:\video translator\backend-node\scripts\ui_check\_artifacts\export\20260926-134521"; archive has [manifest.json, postgres_schema.sql, schema.sql, tables] |
| B24 | SEO card: "robots.txt" and "sitemap.xml" buttons open the generated files | PASS | robots.txt: /robots.txt "# Not a production origin (PUBLIC_BASE_URL is not https), so nothing # here shou"; sitemap.xml: /sitemap.xml "/* Copyright 2014 The Chromium Authors * Use of this source code is governed by " |
| B25 | Maintenance: "Take the site offline" -> note -> "Take it offline now" | PASS | POST -> 200; toast "The site is now in maintenance mode Everyone except an admin session now gets a 503 with Retry-After. You still see the "; badge "Site is off" (shots/014_B_maint_on.png) |
| B26 | Maintenance: the admin still sees the real site | PASS | admin tab on /pricing shows "Pay for minutes, not seats" |
| B27 | Maintenance: a separate signed-out browser sees the maintenance page | **FAIL** (bug) | maintenance page NOT shown: /api/site maintenance=true note="UI check maintenance 0926190147"; /api/billing/plans -> 503 {"detail":"UI check maintenance 0926190147","maintenance":true,"retry_after_s":600}; page h1 "(no h1)", #root innerHTML length 0, body "" (shots/015_B_maint_anon.png) \| noise: PAGEERROR TypeError: Cannot destructure property 'basename' of 'React2.useContext(...)' as it is null. ; PAGEERROR TypeErr… |
| B28 | Maintenance: "Bring the site back" | PASS | POST -> 200; toast "The site is public again The site is public again."; signed-out visitor sees "Your video, speaking every language" again [demo-reel video request to the R2 host blocked by the test guard] |
| B29 | Database tab "Open the browser" opens /db in a new tab | PASS | /db: 23 tables; file "c:\video translator\backend\data\vn_ui_0926190147.db (4 KB)" (shots/016_B_db_home.png) |
| B30 | /db: open the users table — password hashes hidden | PASS | "users - 1 row(s)"; password_hash shown as ["<hidden>"] (shots/017_B_db_users.png) |
| B31 | /db: "next →" / "← prev" paging buttons | PASS | paging info "showing 1 from offset 0" |
| B32 | /db: type a SELECT and press "Run SELECT" | **FAIL** (bug) | POST /api/admin/db/query -> 403; page shows error "bad or missing CSRF token" (title "users - 1 row(s)") (shots/018_B_db_query.png) |
| B33 | /db query API with the CSRF header (what the page should send): SELECT works, hashes masked, writes refused | PASS | SELECT -> 200, password_hash ["<hidden>"]; aliased -> 200 [null]; DELETE -> 400 "{"detail":"only SELECT, WITH or PRAGMA table_info are allowed here"}" |
| B34 | /db: "back to the app" link | PASS | -> / (the public homepage, not the dashboard) [demo-reel video request to the R2 host blocked by the test guard] |
| B35 | Signups by address — admin UI control | **FAIL** (missing UI) | No page or button in the React admin (/app/admin/*) reaches GET /api/admin/signups; API itself -> 200 {"window_hours":168,"min_accounts":1,"clusters":[{"ip":"127.0.0.1","accounts":1,"confirmed":1,"suspended":0,"first_at":"2026-09-26T13:44:59Z","last_at":"2026-09-26T13:44:59Z","users":[{"id":1,"email": |
| B36 | Access log — admin UI control | **FAIL** (missing UI) | No page or button in the React admin (/app/admin/*) reaches GET /api/admin/access-log; API itself -> 200 {"access_log":[{"id":23,"at":"2026-09-26T13:45:42Z","admin_user_id":1,"admin_email":"ui-admin-0926190147@example.com","surface":"admin.signups","target_user_id":null,"rows_returned":1,"detail":"window |
| B37 | User consent record — admin UI control | **FAIL** (missing UI) | No page or button in the React admin (/app/admin/*) reaches GET /api/admin/users/1/consent; API itself -> 200 {"user_id":1,"current":{"analytics":{"granted":false,"notice_version":"2026-08-26.1-draft","at":"2026-09-26T13:44:59Z","method":"banner"},"service_terms":{"granted":true,"notice_version":"2026-08-26.1 |
| B38 | A user's jobs — admin UI control | **FAIL** (missing UI) | No page or button in the React admin (/app/admin/*) reaches GET /api/admin/users/1/jobs; API itself -> 200 {"user_id":1,"jobs":[]} |
| B39 | Billing admin — admin UI control | **FAIL** (missing UI) | No page or button in the React admin (/app/admin/*) reaches GET /api/admin/billing; API itself -> 200 {"provider":{"provider":"razorpay-test","live":false,"real_money_possible":false,"key_id_public":null,"webhook_secret_set":false,"mandate_ceiling_rupees":15000,"grace_days":7,"reminder_days":[14,3,0], |
| B40 | Billing sweep — admin UI control | **FAIL** (missing UI) | No page or button in the React admin (/app/admin/*) reaches POST /api/admin/billing/sweep; API itself -> 200 {"reminders":{"sent":[]},"expiries":{"expired":[]},"plan_changes":{"applied":0,"changes":[]}} |
| B41 | DPDP readiness (Inbox card + /api/admin/dpdp) | PASS | -> 200 ready=false; failing: grievance contact published; notice version is not the draft default; session cookie is Secure; public base URL is https; signup refuses registration without consent |
| B42 | Backend operator page (http://127.0.0.1:8096/) "Billing" view — only UI for billing admin | PASS | operator console "VoiceStudio backend - test console" loads; after "Billing": billing data rendered (shots/019_B_operator_billing.png) |

### C. Regular account, end to end — 36/41 passed

| # | Item | Result | Note |
|---|---|---|---|
| C1 | Sign up in the UI -> "Check your inbox" (confirm your email) | PASS | register 200 verification_required=true; "We sent a confirmation link to ui-user-0926190147@example.com. Open it and then sign in — the link is good for 24 hours."; mail 20260926-135348_000002_verify_email_ui-user-0926190147@example.com.txt (shots/044_C_check_inbox.png) |
| C2 | "Send the link again" on the check-your-inbox panel | PASS | button -> "Sent again" (disabled=true); new mail 20260926-135348_000003_verify_email_ui-user-0926190147@example.com.txt |
| C3 | Sign in before confirming is refused with the confirm-your-email note (+ resend) | PASS | refused (403 email_not_confirmed) with the note; resend -> "A new confirmation link is on its way…", mail 20260926-135350_000004_verify_email_ui-user-0926190147@example.com.txt (shots/045_C_login_unconfirmed.png) |
| C4 | Only the newest confirmation link works (first link rejected, via API) | PASS | first link -> 400 "that confirmation link is invalid or has expired" |
| C5 | Open the newest confirmation link from the outbox -> signed in, lands in /app | **FAIL** (dev server only) | after 15 s still on /verify?token=<redacted> showing "Confirming your address" / "Kresker Confirming your address One moment. Checking that link…"; yet /api/auth/me -> 200 (the backend DID confirm and sign in) (shots/046_C_verify_link.png) |
| C6 | Dashboard: plan card, minutes, no admin menu, "Upgrade" link | PASS | sidebar "1.00 of 1 min left", plan Free (60s max), service line "Ready to dub", no admin links; "Upgrade" -> /app/billing (shots/047_C_dashboard.png) |
| C7 | Upload _realtest_30s.mp4 (file picker) | PASS | POST /api/uploads -> 200 duration 28s minutes 0.467; page: "Length28sWill use0sLeft after this1.00 minDub intoUp to 8 at a tim" (direct-to-storage presign answered 503 as expected with R2 off, the page fell back to multipart) (shots/048_C_uploaded.png) |
| C8 | Language picker: search, pick Hindi, "None" clears, pick again | PASS | Hindi chip + "Dub into Hindi"; "None" -> disabled "Pick a language" (true); search by code "hi" works; trigger reads "1 of 8 selected" (1) (shots/049_C_language.png) |
| C9 | Start the dub and watch it to done | PASS | POST /api/jobs -> 200 job 4f5ecff0466f charged 0.467 min; toast "Your dub is running You can close this tab. It keeps going o"; "Your dub is ready" after ~7s; job_done mail 20260926-135416_000005_job_done_ui-user-0926190147@example.com.txt (shots/050_C_dub_running.png, shots/051_C_dub_ready.png) |
| C10 | Recent dubs table lists the finished job | PASS | row: "4f5ecff0466f Hindi Ready 28s 23h 59m 26 Sept, 07:24 pm Get" |
| C11 | "Open and download" -> job page with transcript and events | PASS | badge Ready; Minutes used28sFile; File size791 KBDownloads0Deleted23h; transcript 4 lines; events section present=true (shots/052_C_job_page.png) |
| C12 | Play the dub in the page (Playwright Chromium) | PASS | src /dl/eyJkIjoi…; played to 2.5s of 28s (shots/053_C_player_chromium.png) |
| C13 | Player "Audio only" tab | PASS | tab aria-selected=true; audio element=true src /dl/eyJkIjoiaW…; play {"err":null,"t":1.960083,"code":null} |
| C14 | Download menu: video | PASS | menu item "MP4" -> "dubbed_hindi_Kresker_4f5ecff0.mp4" 810011 bytes, video:h264[hin],audio:aac[hin], 28.0s |
| C15 | Download menu: m4a | PASS | menu item "M4A" -> "dubbed_hindi_Kresker_4f5ecff0.m4a" 14031 bytes, audio:aac[hin], 28.0s |
| C16 | Download menu: mp3 | PASS | menu item "MP3" -> "dubbed_hindi_Kresker_4f5ecff0.mp3" 1122388 bytes, audio:mp3, 28.0s |
| C17 | Download menu: wav | PASS | menu item "WAV" -> "dubbed_hindi_Kresker_4f5ecff0.wav" 5374030 bytes, audio:pcm_s16le, 28.0s; toast "WAV is uncompressed Uncompressed 48 kHz. Large — roughly 11 MB a minute — but it" |
| C18 | Downloads counter on the job page went up | PASS | Downloads = 4 |
| C19 | Minutes used went down (sidebar + /api/auth/me) | PASS | before 1 left -> after 0.533 left (used 0.467); sidebar "0.53 of 1 min left" |
| C20 | Play the dub in Google Chrome (codec-capable browser, same page, same guards) | PASS | Chrome 153.0.8010.53: video played to 2.5s (854x480, duration 28); audio-only played to 2.4s (shots/054_C_player_chrome.png) |
| C21 | Library: row, filter chips, search, refresh, row "Get" menu | PASS | chips running:pressed=true,row=0 done:pressed=true,row=1 failed:pressed=true,row=0 all:pressed=true,row=1; search "Hindi" -> 1 row; "zzzz" -> "Nothing matches that"; row menu offers [video, m4a, mp3, wav] (shots/055_C_library.png) |
| C22 | Billing page: current plan, notice, plan list, top-ups message | PASS | notice "Paid plans are not open yet. You can use the free plan in th…"; current "FreeFree0.53 of 1 minutes left"; plan cards [Starter, Creator, Pro]; buttons [Monthly \| Annual \| Choose Starter \| Choose Creator \| Choose Pro]; plans.open=true; top-ups heading "Topup Extra minutes" message "Extra minutes are for people on a monthly or annual plan. Choose a plan first and you can top up any time after." (shots/056_C_bil… |
| C23 | Billing: pressing "Choose Starter" (test mode) shows "Paid plans are not open yet" and changes nothing | PASS | POST /api/billing/checkout -> 200 live=false checkout_url=null order sub_TEST12b2268a65c85b; toast "Paid plans are not open yet Nothing was charged and your plan has not changed. We will announce it here as soon as they are available."; still on Free (shots/057_C_billing_choose.png) |
| C24 | Billing: Monthly / Annual toggle | PASS | annual cards + "Why annual is a one-off payment." note (true); back to monthly |
| C25 | Your data (/app/privacy): consent toggles | PASS | 2 optional purpose(s): "Email me about new features and improvements": Turn on -> toast "Recorded — thank you" -> back; "Allow anonymous usage analytics": Turn on -> toast "Recorded — thank you" -> back (shots/058_C_privacy.png) |
| C26 | Your data: consent history "Show N" | PASS | "Show 7" -> 7 rows, "Hide" collapses |
| C27 | Your data: "Download my data" export | PASS | downloaded "export.json" (4602 bytes) keys [generated_at, notice_version, note, account, consent, sessions, subscriptions, payments, usage_ledger, uploads, jobs, transcripts, messages_to_us, emails_we_sent]; jobs=1 sessions=1; no hashes/tokens |
| C28 | Your data: "Ask here" link -> /contact?kind=correction | PASS | rights form pre-selected "correction", email pre-filled "ui-user-0926190147@example.com" |
| C29 | Link in the job_done email opens the job | **FAIL** (bug) | mail link /?job=4f5ecff0466f leaves the customer on /?job=4f5ecff0466f ("Your video, speaking every language"), not on their job (shots/059_C_job_done_link.png) [demo-reel video request to the R2 host blocked by the test guard] |
| C30 | Job page "Delete now" (confirm) removes the video file | PASS | DELETE -> 200; toast "Video deleted"; notice "This video was deleted by you…"; player gone (true); outputs/4f5ecff0466f.mp4 existed before=true, after=false; same DELETE with NO X-CSRF-Token -> 200 {"ok":true,"already":true} (shots/060_C_deleted.png) |
| C31 | Sign out from the sidebar | PASS | -> /login?next=%2Fapp; /me 401 |
| C32 | Forgot password: request a reset link for the account | PASS | neutral confirmation shown; mail 20260926-135949_000007_password_reset_ui-user-0926190147@example.com.txt with link http://127.0.0.1:5174/reset?token=… |
| C33 | Reset link: mismatch is caught, new password saved, "Go to sign in" | PASS | mismatch -> "These do not match."; confirm -> 200; "Password changed" + "No other sessions were open."; "Go to sign in" -> /login (shots/071_C_password_changed.png) |
| C34 | Reset link cannot be used twice | PASS | second use -> 400 "that reset link is invalid or has expired" |
| C35 | Old password no longer works | PASS | refused with "That email and password do not match." |
| C36 | Sign in with the new password | PASS | signed in, on /app |
| C37 | Close account: wrong password is refused | PASS | "Erase everything" disabled until filled (true) and for lower-case "delete" (true); wrong password -> "That password is not right." (shots/072_C_erase_wrong_pw.png) |
| C38 | Close account: correct password + DELETE erases the account | **FAIL** (bug (critical)) | POST /api/privacy/erase -> 500 {"detail":"Something went wrong on our side.","reference":"fe0a67fc81b6"} (second attempt: reference fc89783ce426). The page shows the red note "Something went wrong on our side."; the account stays signed in (/api/auth/me 200) and its uploads/jobs rows remain, but the source video file was already deleted from disk. Backend log: SqliteError: FOREIGN KEY constraint failed at wipe (dist… |
| C39 | After erasure: "Sign out" button, account_erased mail, sign-in refused | **FAIL** (bug (critical)) | Cannot pass: the erasure above failed, so there is no "Done" card, no account_erased mail for this address, and signing in with the new password still works (POST /api/auth/login 200 in the backend log). |
| C40 | Close account (account that never dubbed): erasure completes, mail sent, sign-in refused | PASS | erase -> 200 deleted {"files":0,"job_segments":0,"job_artifacts":0,"job_events":0,"uploads":0,"sessions":3,"checkout_sessions":1,"emails":1,"inbox_messages":0,"consent_records":1,"jobs":0}; toast "Your account is closed"; "Done" card (shots/074_C_erased_third.png); in-card "Sign out" -> /login; mail 20260926-140217_000008_account_erased_ui-third-0926190147@example.com.txt; sign-in refused; users row now [{"id":3,"em… |
| C41 | DELETE /api/jobs/{id}/video enforces CSRF like the other state-changing routes | **FAIL** (security hardening) | customer's DELETE /api/jobs/4f5ecff0466f/video with NO X-CSRF-Token -> 200 {"ok":true,"already":true} (the handler ran); for comparison POST /api/admin/maintenance without the header -> 403 "bad or missing CSRF token". SameSite=Lax limits the exposure, but this route is the odd one out |

### D. Back as admin — refund, plans, suspension, sessions — 14/17 passed

| # | Item | Result | Note |
|---|---|---|---|
| D1 | Customer's account and dub show in admin People (Dubs, minutes) | PASS | row "ui-user-0926190147@example.com Free 28s used · 32s left 1 26 Sept, 07:23 pm Grant plan Block buying" (shots/061_D_people_user.png) |
| D2 | Overview "Jobs today" counts the dub | PASS | jobs_today=1, users=2 |
| D3 | Customer's jobs list — admin UI control | **FAIL** (missing UI) | No UI: nothing in /app/admin/* lists a user's jobs (api.admin.userJobs is never called). API -> 200: job 4f5ecff0466f state=done charged=0.467 refundable=true video "_realtest_30s.mp4" |
| D4 | Refund button on the customer's job (password re-entry) | **FAIL** (missing UI) | No refund button anywhere in the admin UI (0 matching buttons on the page; api.admin.refund has no caller). Tested the endpoint directly in the next row. |
| D5 | Refund via API: wrong password refused, right password refunds, second refund refused | PASS | wrong pw -> 403 "this action needs your password again"; right pw -> 200 {"ok":true,"minutes_refunded":0.467,"method":"compensating ledger row; the original charge is untouched"}; again -> 409 "that job was already refunded"; customer minutes_left 0.533 -> 1.000, their sidebar "1.00 of 1 min left" (shots/062_D_user_after_refund.png) |
| D6 | Third throwaway account: sign up + confirm from the outbox | PASS | user #3 confirmed via 20260926-135755_000006_verify_email_ui-third-0926190147@example.com.txt; confirm page hung on "Checking that link…" again (see C) - opened /app by hand, session was valid |
| D7 | Grant plan dialog: wrong password shows an error, right password grants Starter | PASS | wrong pw -> error "this action needs your password again" (shots/063_D_grant_wrong_pw.png); right pw -> toast "ui-third-0926190147@example.com is on starter Until 2026-10-26T13:58:10Z. Recorded as a gift, so it does not t"; row now "ui-third-0926190147@example.com Starter no renew 0s used · 10.00 min left 0 26 Sept, 07:27 pm Grant plan Stop plan Block buying" (shots/064_D_granted.png) |
| D8 | Third account sees the granted plan (sidebar + billing page) | PASS | sidebar "10.00 of 10 min left"; billing: Active + "Does not renew"; top-ups picker offered (shots/065_D_third_billing.png) |
| D9 | Third account: buy a top-up pack (test mode, nothing charged) | PASS | picked "10 minutes ₹249 + GST ₹24.90 a minute"; POST /api/billing/topup -> 200 live=false url=null; toast "Nothing to pay just now nothing is charged until the payment provider confirms it. These minutes are added on top of you"; extra minutes now 0 |
| D10 | "Block buying" (password) -> badge "no buying" and the account cannot buy | PASS | toast "ui-third-0926190147@example.com cannot buy anything Their plan, minutes and finished dubs "; row "ui-third-0926190147@example.com no buying Starter no renew 0s used · 10.00 min left 0 26 Sept, 07:27 pm Grant plan Stop "; their plans.open=false; their checkout -> 403 "[object Object]"; Creator card button "Not open yet" (shots/066_D_third_blocked.png) |
| D11 | "Allow buying" (password) lifts the block | PASS | toast "ui-third-0926190147@example.com can buy again Plans, extra minutes and plan changes are av"; their plans.open=true |
| D12 | "Stop plan" (password, at renewal) then again with "End it now" | PASS | at renewal: toast "ui-third-0926190147@example.com: starter stopped No further payments. Access continues until 2026-10", row "ui-third-0926190147@example.com Starter no renew 0s used · 10.00 min left 0 26 Sept, 07:27"; end now: toast "ui-third-0926190147@example.com: starter stopped Access ended now.", row "ui-third-0926190147@example.com Free 0s used · 1.00 min left 0 26 Sept, 07:27 pm Grant pla"; their plan now F… |
| D13 | Suspend / unsuspend — admin UI control | **FAIL** (missing UI) | No suspend or unsuspend button in the admin UI (0 on the account row; there is no api.admin.suspend at all - only a read-only "suspended" badge). Tested the endpoints directly in the next row. |
| D14 | Suspend via API signs the account out and blocks sign-in; admin row shows "suspended"; unsuspend restores sign-in | PASS | wrong pw -> 403; suspend -> 200 sessions_revoked=1; self-suspend -> 400 "you cannot suspend your own account"; their /me -> 401; row "ui-third-0926190147@example.com suspended Free 0s used · 1.00 min left 0 26 Sept" (shots/067_D_suspended_row.png); their sign-in -> "this account has been suspended. Use the contact form and we will look into it." (shots/068_D_suspended_login.png); unsuspend -> 200 "they will need to … |
| D15 | After unsuspend the account can sign in again (login with ?next=//example.org/… stays on-site) | PASS | signed in (/me 200); after login the browser is at /example.org/ui-check (on-site) (shots/069_D_login_next.png) |
| D16 | People "Who is signed in" -> "End" signs that session out | PASS | toast "Session ended"; their /me -> 401; their /app now redirects to /login?next=%2Fapp |
| D17 | Admin audit card records every action above | PASS | all 11 action kinds present (shots/070_D_audit.png) |

### E. Everything else — 25/31 passed

| # | Item | Result | Note |
|---|---|---|---|
| E1 | Contact page "Data rights request" (access) is filed with a deadline (re-check) | PASS | the first run's two submissions (access, erasure) reached the inbox: #3 erasure new due 2026-10-26T14:04:34Z; #2 access resolved due 2026-10-26T14:04:03Z; rights_ack mails: 20260926-140403_000009_rights_ack_ui-rights-0926190147@example.com.txt, 20260926-140434_000010_rights_ack_ui-rights-0926190147@example.com.txt |
| E2 | Admin inbox: pick up the access request, refuse to resolve without a note, then resolve | PASS | row "Access request new no account matched access request ui-rights-0926190147@example.com · 1m ago 30d left due 26 October 2"; "Picking this up" -> "#2 marked in progress"; Resolved w/o note -> "Say what was actually done A rights request marked resolved with no note cannot "; with note -> "#2 marked resolved" (shots/075_E_inbox_rights.png) |
| E3 | Admin inbox: erasure request shows the identity warning; "Reject" (re-check) | PASS | identity warning shown=true; "Reject" -> "#3 marked rejected" (shots/083_E_inbox_erasure.png) |
| E4 | Signup with an address that already has an account | PASS | "That email already has an account. Try signing in instead." |
| E5 | Signup with a +tag of an existing inbox | PASS | "that address reaches an inbox that already has an account - sign in instead, or use the password reset link" |
| E6 | Verify page with a bogus token (evidence for the confirm-page hang) | **FAIL** (dev server only) | after 12 s the page still reads "Confirming your address" / "Checking that link…" although POST /api/auth/verify already answered 400 (shots/076_E_verify_bogus.png) |
| E7 | "Try again" link in the job_failed email (/app/dubbing) | **FAIL** (bug) | signed-in visit to /app/dubbing renders the 404 page "There is nothing here" (notify.ts builds this link for every failed dub) (shots/077_E_app_dubbing.png) |
| E8 | Contact page "Prefer email? Write to …" line (no grievance e-mail configured) | **FAIL** (bug (config-dependent)) | renders "Prefer email? Write to NOT CONFIGURED and it reaches the same place as this form." with a link to "mailto:NOT CONFIGURED" (shots/078_E_contact_email_line.png) |
| E9 | Your data: sessions list / sign out other sessions (re-check, inside the page body) | **FAIL** (missing UI) | headings [Your data \| What you have agreed to \| Your consent history \| Close my account and erase my data \| Take a copy]; buttons [Turn on \| Turn on \| Show 2 \| I want to close my account \| Download my data] - no sessions list or "sign out other sessions" control for customers (the only session control is the sidebar "Sign out" for this browser) |
| E10 | Unknown job id -> "That job does not exist, or it is not yours." + "Back to dubbing" | PASS | message shown; button -> /app |
| E11 | Grant dialog "Cancel" and Escape close without granting | PASS | both close the dialog |
| E12 | Admin: "Block buying" on your own account is refused with a message | PASS | refused inside the dialog: "you cannot block your own account from buying" |
| E13 | Phone width (390px) dashboard: "Open navigation" drawer works | PASS | drawer opens, "People" navigates; horizontal overflow on /app/admin/people = 0px (shots/079_E_phone_drawer.png, shots/080_E_phone_people.png) |
| E14 | /openapi.json through the site origin | PASS | /openapi.json -> 200 with 84 paths (the /docs half is its own row) |
| E15 | Contact page "Data rights request" (correction): "Got it." page with the deadline | PASS | -> 200 id=4; page "Got it. Reference #4" + "we will answer by 2026-10-26 14:06:54 UTC"; mail 20260926-140654_000011_rights_ack_ui-rights-0926190147@example.com.txt (shots/082_E_rights_correction.png) |
| E16 | Admin inbox: "Reply by email" on a rights request is a mailto: (not clicked) | PASS | href mailto:ui-rights-0926190147%40example.com?subject=Re%3A%20correction%20request%20(%234); resolved with a note -> "#4 marked resolved" |
| E17 | /docs (Swagger UI) renders through the site origin | **FAIL** (bug (dev-only page)) | body text length 0; 4 CSP refusals, e.g. "Loading the stylesheet 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css' violates the following Content Security Policy direct" — the page pulls Swagger UI from cdn.jsdelivr.net plus an inline script, and the backend's own CSP (script-src 'self') forbids both, so it cannot render even with network access (shots/090_X_docs.png) \| noise: console.error: Loading th… |
| E18 | Dubbing: "Remove this file" after an upload returns to the drop zone | PASS | ok |
| E19 | Dubbing: "Cancel" after an upload returns to the drop zone | PASS | ok |
| E20 | Dubbing: two languages in one batch (Hindi + Telugu) -> "All 2 dubs are ready" | PASS | "Will use" hint: "Will use56s28s × 2 languages"; jobs 8a68a6222bc3, b9150b043fb3; toast "2 dubs are running They run one after another, so "; per-language rows with links: 2 (shots/091_E2_batch_running.png, shots/092_E2_batch_ready.png) |
| E21 | Batch row language link opens that job; "Dub another video" resets | PASS | language link -> job page; after Back the batch panel is gone (page state reset on navigation), drop zone shown |
| E22 | Recent dubs: job id link -> job page; back link "Dubbing" -> /app | PASS | ok |
| E23 | Dubbing aside plan card button -> /app/billing | PASS | "See plans" -> /app/billing |
| E24 | Sidebar brand "Kresker" -> homepage, whose nav then offers "Open dashboard" | PASS | ok [demo-reel video request to the R2 host blocked by the test guard] |
| E25 | Reset form with an invalid token shows the expired-link message | PASS | "That reset link is invalid or has expired. Ask for a new one." |
| E26 | Auth footer link "Sign in" on /signup (re-check) | PASS | -> /login |
| E27 | Auth footer link "Sign in" on /verify (re-check) | PASS | -> /login |
| E28 | Auth footer link "Need a new link?" on /reset (with token) (re-check) | PASS | -> /reset |
| E29 | Auth footer link "Back to sign in" on /reset (re-check) | PASS | -> /login |
| E30 | Auth footer link "Create an account" on /login (re-check) | PASS | -> /signup |
| E31 | After "Remove this file" / "Cancel", the uploaded video is removed from the server | **FAIL** (privacy / retention) | 2 upload(s) the admin removed/cancelled in the UI are still on disk with no job: uploads/3c00323c88fa4a6582326f26ae8882e2__realtest_30s.mp4, uploads/29ba94f515054d0db35fc184b9e73c47__realtest_30s.mp4; the source of a finished dub is also kept (uploads/158cde985a9c4dc6a2c10cabdc152b8c__realtest_30s.mp4). Nothing in the Node backend deletes local source uploads except account closure (routers/privacy.ts), while the fo… |

### P. Production build cross-check (vite build + vite preview on :5175) — 2/3 passed

| # | Item | Result | Note |
|---|---|---|---|
| P1 | Production build: confirmation link lands in /app (re-check) | PASS | production build: confirmation link -> dashboard "Dubbing" in 0.4s, signed in (shots/089_P_verify_prod_dashboard.png) |
| P2 | Production build: bogus confirmation token shows "That link did not work" | PASS | failure screen shown (shots/087_P_verify_bogus_prod.png) |
| P3 | Production build: signed-out visitor during maintenance | **FAIL** (bug) | maintenance on -> 200; production build page: h1 "(no h1)", #root innerHTML length 0 (shots/088_P_maint_prod.png); maintenance off -> 200 \| noise: console.error: TypeError: Cannot destructure property 'basename' of 'R.useContext(...)' as it is null. at http://127.0.0.1:5175/assets/react-vendor-B6_-fu1G.js:59:1950 at qi (http://127.0.0.1:5175/assets/rea @ http://127.0.0.1:5175/assets/react-vendor-B6_-fu1G.js ; PAGEER… |

## Problems found

Real product bugs first, most serious first. Then missing features, then things that only happen in the dev server, then test-environment limitations.

### 1. Closing an account fails with HTTP 500 for anyone who has ever dubbed a video (critical)

- **Repro:** sign up, confirm, upload `_realtest_30s.mp4`, dub it into Hindi. Go to Your data (`/app/privacy`) → "I want to close my account" → enter the password, type `DELETE` → "Erase everything".
- **Expected:** 200, the "Done" card, an `account_erased` mail, and sign-in refused afterwards.
- **Actual:** `POST /api/privacy/erase` → **500** `{"detail":"Something went wrong on our side.","reference":"fe0a67fc81b6"}`. The page shows "Something went wrong on our side." The account still exists and still signs in, and no `account_erased` mail is written. A second attempt gave the same result (reference `fc89783ce426`).
- **Backend log:** `[500 fe0a67fc81b6] POST /api/privacy/erase` → `SqliteError: FOREIGN KEY constraint failed at wipe (dist/routers/privacy.js:359)` inside `db.transaction`.
- **Cause:** `src/routers/privacy.ts:361` deletes the `uploads` rows first, but `jobs.upload_id REFERENCES uploads(id)` (`sql/schema.sql:204`, no `ON DELETE`) and the `jobs` rows are only deleted at line 371. With `foreign_keys = ON`, the first DELETE fails and the transaction rolls back.
- **Side effect:** the files are unlinked *before* the transaction, so the failed attempt still deleted the customer's source video (`uploads/4dd48d3b…__realtest_30s.mp4` was gone from disk afterwards) while its DB row survived.
- **Control:** the third account had no dubs. Its erasure succeeded: 200, "Done" card, `account_erased` mail, sign-in refused, and the user row tombstoned as `erased-3@invalid`.
- **Evidence:** `shots/072_C_erase_wrong_pw.png`, `shots/073_C_erase_500.png`, `shots/074_C_erased_third.png`.

### 2. Maintenance mode gives signed-out visitors a blank page (high)

- **Repro:** as admin, System (`/app/admin/system`) → "Take the site offline" → type a note → "Take it offline now". Then open `http://127.0.0.1:5174/` in a separate signed-out browser.
- **Expected:** the "We are making some changes" page with the note.
- **Actual:** an empty page (`#root` is empty) with an uncaught `TypeError: Cannot destructure property 'basename' of 'React2.useContext(...)' as it is null` ("The above error occurred in the `<Link>` component").
- **Production build:** the same crash happens in `vite build` + `vite preview` (`…of 'R.useContext(...)'`), so this is not a dev-server artefact.
- **Cause:** `src/App.tsx:256` returns `<Maintenance/>` before `<BrowserRouter>` is rendered. `src/marketing/Maintenance.tsx:74` renders a react-router `<Link to="/contact">` ("Get in touch"), which needs a router.
- **What does work:** the backend side. `/api/site` reports `maintenance:true` with the note, `/api/billing/plans` answers 503 JSON, the admin still sees the real site, and "Bring the site back" restores everything.
- **Evidence:** `shots/015_B_maint_anon.png` (dev), `shots/088_P_maint_prod.png` (production build).

### 3. GPU "Force stop" runs the real AWS CLI even with the fake engine, and the admin pages poll AWS (high, safety)

- **Repro:** admin → Capacity (`/app/admin/gpu`) → "Force stop" → accept the confirm.
- **Actual:** `POST /api/admin/gpu/stop?force=true` → 200 `{"forced":true,…,"rc":1}` and the toast says "Force stopped".
- **Cause:** `src/routers/admin.ts:519` calls `gpu.aws(['ec2','stop-instances','--instance-ids', GPU_INSTANCE_ID])` with no `gpu.enabled()` or fake-mode check. `GPU_INSTANCE_ID` defaults to the real `i-041b48c591cb86e19`, with profile `videotrans` and region `ap-south-1` (`src/config.ts:115-119`).
- **The pages too:** `gpu.state()` → `describe()` (`src/gpu.ts:77, 381`) runs `aws ec2 describe-instances` with no guard. It is reached by `GET /api/admin/overview` (polled every 15 s) and `GET /api/admin/gpu` (every 10 s). A failed call is not cached, so it runs again on every poll.
- **Risk:** with the environment exactly as specified for this task (`aws.exe` on PATH), a local test click would have tried to stop the production GPU box. It failed (`rc=1`) only because this run hid the AWS CLI from the backend (see "How it was run"). The "fake: buttons are harmless" assumption does not hold for "Force stop".
- **Also:** the toast says "Force stopped" whatever `rc` is.
- **Harmless in fake mode:** "Warm it up" and "Stop if idle" behaved correctly.

### 4. Database browser: "Run SELECT" always fails with "bad or missing CSRF token" (medium)

- **Repro:** admin → System → Database → "Open the browser" (`/db`) → type any SELECT → "Run SELECT".
- **Actual:** `POST /api/admin/db/query` → 403, and the page shows "bad or missing CSRF token".
- **Cause:** the `api()` helper in `static/db.html` sends no `X-CSRF-Token`, but `src/routers/dbbrowse.ts:215` requires one.
- **What does work:** browsing tables (GET). There, `password_hash` shows as `<hidden>`. The same query sent with the header returns 200, hashes masked, an aliased hash comes back `null`, and `DELETE…` is refused with 400.
- **Evidence:** `shots/018_B_db_query.png`, `shots/017_B_db_users.png`.

### 5. The "your dub is ready" email link opens the homepage, not the dub (medium)

- **Repro:** finish a dub, then open the link from the `job_done` mail, e.g. `…_000005_job_done_ui-user-0926190147@example.com.txt` → `http://127.0.0.1:5174/?job=4f5ecff0466f`, while signed in.
- **Actual:** the marketing landing page ("Your video, speaking every language").
- **Cause:** `src/notify.ts:326` builds `${baseUrl}/?job=${jobId}`, and nothing in `frontend/src` reads a `job` query parameter. It should point at `/app/jobs/<id>`.
- **Evidence:** `shots/059_C_job_done_link.png`.

### 6. The "Try again" link in the job-failed email is a 404 (low)

- **Cause:** `src/notify.ts:384` links to `${PUBLIC_BASE_URL}/app/dubbing`, and there is no such route (the dubbing page is `/app`).
- **Actual:** a signed-in visit renders "There is nothing here". I did not trigger a real failed job, because the fake engine never failed.
- **Evidence:** `shots/077_E_app_dubbing.png`.

### 7. Contact page tells visitors to "Write to NOT CONFIGURED" (low, only when no grievance email is set)

- **Actual:** "Prefer email? Write to NOT CONFIGURED and it reaches the same place as this form.", where "NOT CONFIGURED" is a `mailto:NOT CONFIGURED` link.
- **Cause:** `src/legal/Contact.tsx:166` shows the line whenever `notice.grievance.email` is truthy, and the backend returns the placeholder string `'NOT CONFIGURED'` when `VS_GRIEVANCE_EMAIL` is unset (`src/consent.ts:36`). It should check `grievance.configured`.
- **Evidence:** `shots/006_A_page_contact.png`, `shots/078_E_contact_email_line.png`.

### 8. Uploaded source videos are never deleted: "Remove this file" and "Cancel" leave them on the server (medium, privacy)

- **What I saw:** after an upload, "Remove this file" and "Cancel" reset the page but leave the video on disk. `uploads/3c00323c…__realtest_30s.mp4` and `uploads/29ba94f5…__realtest_30s.mp4` stayed, with no job attached.
- **Finished dubs too:** the source of a finished dub stays as well (`uploads/158cde98…`).
- **Cause:** the Node backend deletes a local source upload only when the upload itself is refused (too long, not enough minutes) or when the account is closed (see the comment in `routers/privacy.ts`). The retention sweep (`worker.sweepExpired`) only removes outputs, yet the footer says "Videos are deleted automatically."

### 9. Admin features that exist in the API but have no admin UI (missing UI)

- **No page or button for:** a user's jobs (`GET /api/admin/users/{id}/jobs`), refunds (`POST /api/admin/jobs/{id}/refund`), suspend/unsuspend (`POST /api/admin/users/{id}/suspend|unsuspend`, which has no helper in `lib/api.ts` either; the People table only shows a read-only "suspended" badge), signups by address (`/api/admin/signups`), a user's consent record, the access log, billing admin (`/api/admin/billing`) and the billing sweep.
- **Unused helpers:** `lib/api.ts` defines `userJobs`, `refund`, `accessLog`, `userConsent`, `billing`, `billingSweep`, `dbTable`, `dbQuery` and `revoke`, and nothing calls them.
- **The endpoints themselves work** when called directly:
  - Refund: wrong password → 403 "this action needs your password again"; right password → 200, and the customer's balance went 0.533 → 1.000 min (sidebar "1.00 of 1 min left"); a second refund → 409.
  - Suspend: 200 and the account's sessions are revoked. Its sign-in then shows "this account has been suspended…", the People row shows "suspended", suspending yourself → 400, and unsuspend → 200.
- **Billing data** is only viewable on the backend's legacy operator page (`http://127.0.0.1:8096/`, "Billing"), which is not part of the site.

### 10. Customers cannot see or end their other sessions (missing feature)

- `/app/privacy` has consent, history, export and account closure, but no sessions list and no "sign out other devices" control.
- The only session control is the sidebar "Sign out" for the current browser. Sessions show up only inside the JSON export and in the admin panel. A password reset does end other sessions.

### 11. `DELETE /api/jobs/{id}/video` skips the CSRF check (low, hardening)

- **Actual:** called without `X-CSRF-Token`, it answered 200 `{"ok":true,"already":true}`, so the handler ran. For comparison, `POST /api/admin/maintenance` without the header answers 403 "bad or missing CSRF token".
- **Cause:** `src/routers/jobs.ts:521` has no `requireCsrf`. The SameSite=Lax session cookie limits cross-site use, but this is the only state-changing route I found without the check.

### 12. `/docs` (Swagger UI) is blank (low, developer page only)

- **Cause:** the page loads Swagger UI from `cdn.jsdelivr.net` plus an inline script, and the backend's own CSP (`script-src 'self'`) refuses both. It cannot render even with network access.
- **What works:** `/openapi.json` (84 paths).
- **Evidence:** `shots/090_X_docs.png`.

### Dev server only: the confirmation page hangs on "Checking that link…"

- **What I saw:** opening the emailed `/verify?token=…` link in the Vite dev server leaves the page on "Confirming your address — Checking that link…" for good. The backend has already confirmed the address and set the session: `/api/auth/me` answers 200, and opening `/app` by hand works. A bogus token never shows "That link did not work" either.
- **Cause:** `src/auth/VerifyEmail.tsx:43-46, 99`. Under React StrictMode's double effect run, the first run's cleanup sets `alive=false`, and the second run exits early on the `spent` ref, so nothing ever updates the page.
- **Production build:** fine. The link reached the dashboard in 0.4 s, and a bogus token showed the failure screen.
- **Impact:** not visible to customers in production, but anyone testing sign-up locally hits it, and so would any future double-mount.
- **Evidence:** `shots/046_C_verify_link.png`, `shots/076_E_verify_bogus.png`, `shots/089_P_verify_prod_dashboard.png`, `shots/085_P_verify_bogus_prod.png`.

### Test-environment limitations (not product bugs)

- **Demo reel:** the landing-page videos come from `pub-ecadf7ff6f844029a4030f2afadfb990.r2.dev` (`VITE_DEMO_BASE`). The test's network guard blocked them, so "Play the demo" cannot play here (MediaError 4). The six language buttons still respond.
- **GPU card:** the admin Overview and GPU cards show "AWS says unknown" because the AWS CLI was deliberately hidden from the backend.
- **Payments:** Razorpay test mode with no keys. In this configuration `billing.purchasableBy()` returns true for everyone, so the plan buttons read "Choose Starter" rather than being closed to non-admins. Pressing one creates a test checkout (`sub_TEST…`) and shows the toast "Paid plans are not open yet — Nothing was charged and your plan has not changed…", with the plan unchanged. The message itself is shown properly, both as the notice at the top of the billing page and as the toast. The admin-only gate only applies with Dodo sandbox keys. A top-up bought on a granted plan answered "Nothing to pay just now", and no minutes were added.
- **Google:** Google sign-in is not configured, so the button is hidden and `/api/auth/google/start` returns 404. I did not attempt a sign-in.
- **Mail files:** with the file mail backend, the `.txt` copies of emails stay in `backend/data/mail` after an account is erased (the `emails` rows are deleted).

### Minor observations (not counted)

- **Billing copy:** the top-ups card heading reads "Topup Extra minutes". The plan line says "videos kept 1 days". Several server sentences start in lower case ("extra minutes are used only after…"; the Overview subtitle "cash collected INCLUDING GST…"). The free plan shows as "Free" + badge "Free".
- **Page titles:** `/login`, `/signup`, `/reset` and `/verify` all share the generic title "Kresker — dub any video into any language".
- **Naming:** the admin nav says "Capacity" but that page's heading is "GPU box".
- **`/db` link:** "back to the app" goes to the public homepage.
- **Redirects:** `/login?next=//example.org/…` lands on the on-site 404 `/example.org/…`, so there is no open redirect.
- **Playback:** the bundled Chromium played the H.264/AAC dub, and Google Chrome did too.

### Cleanup

- **Processes:** stopped the backend, the Vite dev server and the `vite preview` server. Playwright closed its browsers at the end of every run.
- **Database:** deleted `backend/data/vn_ui_0926190147.db`. Its `-wal` and `-shm` files no longer existed: SQLite folds them back in and removes them when the backend shuts down cleanly.
- **Media files:** deleted the five media files this run left in the shared data folder: 3 admin uploads and 2 admin batch outputs. The customer's upload and output were already gone. `backend/data/uploads` and `outputs` are back to their pre-run counts (1733 and 946 files).
- **The 15 outbox mails are kept** as evidence, all named `*_0926190147@example.com.txt` in `backend/data/mail/`.
- **Removed from this folder:** the export archive (it held password hashes), the saved browser sessions, the downloaded dubs, the production build and `_state.json`.
- **Kept here:** the scripts, `results.json`, `events.json`, `shots/` and `_artifacts/artifacts.json`.

## Appendix — rows not counted (17)

These are earlier attempts that were re-run, or duplicates merged by hand. Kept here so nothing is hidden.

| Area | Item (first attempt) | Result then | Why it is not counted |
|---|---|---|---|
| A public | Verify page with a bogus token shows "That link did not work" | FAIL | same failure as the E evidence row (which has the screenshot) and the production-build row |
| B admin | Admin signup through the UI (first account) lands on the dashboard | FAIL | re-checked as "Admin signup through the UI (first account) lands on the dashboard (re-check)" (PASS) — the first attempt failed on a test-script problem |
| B admin | Overview page (/app/admin) | FAIL | re-checked as "Overview page (/app/admin) (re-check)" (PASS) — the first attempt failed on a test-script problem |
| B admin | GPU "Force stop" — cancelling the confirm sends nothing | FAIL | re-checked as "GPU "Force stop" — cancelling the confirm sends nothing (re-check)" (PASS) — the first attempt failed on a test-script problem |
| B admin | GPU "Force stop" — accepted | FAIL | same outcome as the re-check; the first attempt also counted the product's own confirm() dialog as an error |
| C user | Your data: sessions list / sign out other sessions | PASS | the first check was too loose (it matched the sidebar "Sign out"); the stricter check inside the page body is the one counted |
| C user | Close account (customer who has a dub): what the UI shows | FAIL | second attempt of the same erasure, merged into the "Close account: correct password + DELETE" row |
| E extras | Contact page "Data rights request" (access) is filed with a deadline | FAIL | re-checked as "Contact page "Data rights request" (access) is filed with a deadline (re-check)" (PASS) — the first attempt failed on a test-script problem |
| E extras | Contact page "Data rights request" (erasure) is filed with a deadline | FAIL | script read a <main> the page does not have; the re-check row confirms both submissions reached the inbox and both acknowledgement mails exist |
| E extras | Admin inbox: erasure request shows the identity warning; "Reject" | FAIL | re-checked as "Admin inbox: erasure request shows the identity warning; "Reject" (re-check)" (PASS) — the first attempt failed on a test-script problem |
| E extras | Admin inbox: erasure request shows the identity warning; "Reject" (re-check) | FAIL | the same step was run again later; the later result is the one counted |
| E extras | Admin inbox: "Reply by email" on a rights request is a mailto: (not clicked) | FAIL | the same step was run again later; the later result is the one counted |
| P prod build | Production build: confirmation link lands in /app | PASS | the same step was run again later; the later result is the one counted |
| P prod build | Production build: bogus confirmation token shows "That link did not work" | PASS | the same step was run again later; the later result is the one counted |
| P prod build | Production build: signed-out visitor during maintenance | FAIL | the same step was run again later; the later result is the one counted |
| P prod build | Production build: confirmation link lands in /app | FAIL | accidental second run of this area with an address that was already registered (409); the re-check with a fresh account is counted |
| E extras | Auth page footer links: signup "Sign in", verify "Sign in", reset-with-token "Need a new link?" | FAIL | script waited on a stale heading; re-checked link by link (five "Auth footer link" rows) |
