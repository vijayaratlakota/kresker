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
