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
