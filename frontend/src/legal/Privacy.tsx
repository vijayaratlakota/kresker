/**
 * The Privacy Notice.
 *
 * Written against the Digital Personal Data Protection Act, 2023 — s.5 (notice),
 * s.6 (consent), ss.11-13 (rights of the data principal) and s.13 (grievance
 * redressal). Every retention period, recipient and cookie on this page comes from
 * `/api/privacy/notice`, which builds it from `config.py` and `consent.py`. Nothing
 * here is typed in twice, so the published notice cannot drift away from what the
 * software does.
 *
 * LEGAL REVIEW: all customer-facing prose. The technical claims are accurate as of
 * the audit in DPDP_PROGRESS.md; the legal characterisation is not a lawyer's.
 */
import { Link } from 'react-router-dom';
import { ErrorNote, Skeleton } from '../ui/primitives';
import { GrievanceBlock } from './Grievance';
import { Bullets, Clause, DataTable, LegalPage } from './LegalPage';
import { useNotice } from './useNotice';

export function Privacy() {
  const { notice, error } = useNotice();

  return (
    <LegalPage
      title="Privacy Notice"
      lede="What we collect, why we have it, how long we keep it, who else sees it, and what you can make us do about it."
      updated={notice ? `Notice version ${notice.notice_version}` : undefined}
      review
    >
      {error && (
        <div className="mb-8">
          <ErrorNote>
            The live retention and recipient details could not be loaded ({error}). The
            sections below that depend on them are incomplete — please reload rather than
            relying on a partial notice.
          </ErrorNote>
        </div>
      )}

      <Clause id="who" n="1" title="Who we are">
        <p>
          Kresker is a video dubbing service. You give us a video, we transcribe the
          speech, translate it, re-voice it in the original speaker&rsquo;s voice, and give
          you the dubbed file back.
        </p>
        <p>
          Under the DPDP Act we are the <em>Data Fiduciary</em> for the personal data
          described here, and you are the <em>Data Principal</em>. In plain terms: we
          decide what happens to this data, so we are the ones answerable for it.
        </p>
        <p className="text-fg-subtle">
          LEGAL REVIEW: the registered entity name, address and jurisdiction have to be
          inserted here before publication.
        </p>
      </Clause>

      <Clause id="what" n="2" title="What we collect, and why">
        <p>
          Two kinds of thing: the account, and the video. The account data is small and
          obvious. The video is the sensitive part, because a video of a person contains
          their face and their voice.
        </p>
        <DataTable
          caption="Personal data we collect and the purpose for each"
          head={['What', 'Why we have it']}
          rows={[
            [
              'Your email address',
              'It is your login, it is where we send the password reset, and it is how we tell you a dub finished or failed.',
            ],
            [
              'Your password',
              'Stored only as a one-way hash. We cannot read it, and a reset replaces it rather than revealing it.',
            ],
            [
              'The video you upload',
              'To dub it. It is the service.',
            ],
            [
              'The speech in that video, as text',
              'Transcribed so it can be translated, then stored alongside the job so you can see what was said and what it became.',
            ],
            [
              'Short audio clips of each speaker',
              'Cut from your own video to copy how each person sounds, which is what makes the dub keep their voice instead of using a stock one.',
            ],
            [
              'Your IP address and browser User-Agent',
              'Recorded against each sign-in, so you and we can tell whether somebody else has been in your account. Also what the rate limits count against.',
            ],
            [
              'Payment records',
              // The provider is NOT named here on purpose. It is named once, in the
              // recipients table below, which is built from the notice the backend
              // serves — so it stays correct if the provider ever changes, instead of
              // this sentence quietly contradicting that table.
              'Amount, date, plan and the payment provider’s reference. We never see or store your card or UPI details — those go straight to the provider named below.',
            ],
            [
              'Minutes used',
              'To count your allowance, and to refund it when a dub fails.',
            ],
            [
              'Messages you send us',
              'So we can answer them, and so a data-rights request has a record and a deadline.',
            ],
          ]}
        />
        <p>
          We do not buy data about you, we do not enrich your profile from anywhere, and
          we do not build a profile at all. There is no advertising anywhere in this
          product.
        </p>
      </Clause>

      <Clause id="lawful" n="3" title="On what basis">
        <p>
          For the things the service cannot run without — your account, dubbing the video
          you asked us to dub, taking payment for a plan you chose — the basis is your
          consent, given when you created the account and again when you uploaded a file.
          We record each of those against the version of this notice you were shown, and
          you can see your own record on your{' '}
          <Link to="/app/privacy" className="text-fg underline underline-offset-2">
            privacy page
          </Link>
          .
        </p>
        <p>
          For anything optional the basis is <em>separate</em> consent, and separate means
          it is never bundled into anything else. Nothing optional is switched on by
          creating an account or by uploading a video: it starts off, it can only be
          turned on from your privacy page or from the privacy banner, and turning it off
          again changes nothing about the service. Right now there is exactly one optional
          thing — product emails — plus the analytics preference in §6, which is recorded
          against a service we do not currently use.
        </p>
        <p>
          Some records survive a withdrawal because a different obligation applies to
          them. Payment records are the example, and{' '}
          <Link to="/privacy#erase" className="text-fg underline underline-offset-2">
            §7
          </Link>{' '}
          says what happens to them.
        </p>
      </Clause>

      <Clause id="keep" n="4" title="How long we keep it">
        {notice ? (
          <DataTable
            caption="Retention periods"
            head={['What', 'How long']}
            rows={[
              [
                'The dubbed video, on the free plan',
                `${notice.retention.dubbed_output_free_hours} hours after it finishes, then it is deleted automatically.`,
              ],
              [
                'The dubbed video, on a paid plan',
                `${notice.retention.dubbed_output_paid_days} days after it finishes, then it is deleted automatically.`,
              ],
              ['The video you uploaded', notice.retention.source_upload],
              ['The transcript and translation', notice.retention.transcripts],
              [
                'Your sign-in session',
                `${notice.retention.session_days} days, or until you sign out.`,
              ],
              [
                'Your account',
                'Until you close it. Closing it erases your personal data — see §7.',
              ],
            ]}
          />
        ) : (
          <Skeleton className="h-56 w-full" />
        )}
        {/*
          There used to be a warning card here, "Being straight about one gap": the
          uploaded video was kept until the account was closed. That gap is closed - the
          original is now deleted on the same timer as the dubs made from it (the row
          above, served from the same constants the deletion runs on) - so the card went
          with it rather than staying to describe something no longer true.
        */}
      </Clause>

      <Clause id="who-else" n="5" title="Who else sees it">
        <p>
          Dubbing is not something we do entirely alone, so parts of your video reach the
          following. Each one gets the minimum it needs to do its job.
        </p>
        {notice ? (
          <DataTable
            caption="Third parties that receive personal data"
            head={['Who', 'What they get', 'Why']}
            rows={notice.recipients.map((r) => [r.who, r.what, r.why])}
          />
        ) : (
          <Skeleton className="h-64 w-full" />
        )}
        <p>
          Your video is processed in Amazon&rsquo;s Mumbai region, so the file itself stays
          in India. The translation and transcription services are called from there;
          whether a given provider processes data outside India depends on that provider,
          and{' '}
          <span className="text-fg">
            LEGAL REVIEW: cross-border transfer under DPDP s.16 needs to be confirmed
            against each provider&rsquo;s terms before publication.
          </span>
        </p>
        <p>
          We do not sell your data. We do not share it for anyone else&rsquo;s marketing.
          Nobody outside this list receives it except where a law requires us to hand it
          over.
        </p>
      </Clause>

      <Clause id="cookies" n="6" title="Cookies, and the trackers we do not have">
        <p>
          This is short, because there is not much to say. We use one cookie and no
          tracking of any kind: no analytics service, no advertising pixel, no session
          recorder, no third-party fonts or scripts. The page you are reading loads
          nothing from anyone else&rsquo;s server.
        </p>
        {notice && (
          <>
            <DataTable
              caption="Cookies and browser storage"
              head={['Name', 'Kind', 'What it does', 'How long']}
              rows={[
                ...notice.cookies.map((c) => [
                  <code key={c.name} className="font-mono text-tiny">{c.name}</code>,
                  c.essential ? 'Cookie · necessary' : 'Cookie · optional',
                  c.why,
                  c.life,
                ]),
                ...(notice.browser_storage ?? []).map((s) => [
                  <code key={s.name} className="font-mono text-tiny">{s.name}</code>,
                  `${s.kind} · ${s.essential ? 'necessary' : 'optional'}`,
                  s.why,
                  s.life,
                ]),
              ]}
            />
            <p>
              {notice.trackers.length === 0 ? (
                <>
                  Trackers currently in use: <strong className="text-fg">none</strong>. If
                  that ever changes, the change is gated behind the analytics choice in the
                  banner, and that choice starts as a no.
                </>
              ) : (
                <>We now use {notice.trackers.length} analytics service(s), listed below.</>
              )}
            </p>
          </>
        )}
      </Clause>

      <Clause id="rights" n="7" title="What you can make us do">
        <p>
          These are your rights under the DPDP Act, in the order people usually want
          them. All of them are free, and none of them requires a reason.
        </p>
        <Bullets
          items={[
            <>
              <strong className="text-fg">See it (s.11).</strong> A complete copy of
              everything we hold about you, as a file, in one click while signed in. It
              excludes your password hash and session tokens, which are credentials and of
              no use to you.
            </>,
            <>
              <strong className="text-fg">Correct it (s.12).</strong> Anything wrong or
              out of date, put right. Ask and we will do it.
            </>,
            <>
              <strong className="text-fg" id="erase">
                Erase it (s.12(3)).
              </strong>{' '}
              Close the account and destroy the data. Your videos, transcripts, voice
              clips, sessions, emails and messages are deleted. Your payment records are
              kept but <em>de-linked</em> from you — the amount and date survive with no
              name, email or account attached, because financial records are held under a
              different obligation than the one that lets us keep your email address. We
              tell you exactly what was kept, and the response is itemised rather than a
              claim that everything is gone.
            </>,
            <>
              <strong className="text-fg">Withdraw consent (s.6(4)).</strong> For anything
              optional, immediately and with no consequence. Withdrawing consent for the
              dubbing itself is not a setting — it is closing the account, because there
              is no service left without it.
            </>,
            <>
              <strong className="text-fg">Nominate someone (s.14).</strong> To exercise
              these rights on your behalf if you cannot.{' '}
              <span className="text-fg-subtle">
                LEGAL REVIEW: no mechanism for this is built yet. Requests are handled
                manually through the contact form.
              </span>
            </>,
            <>
              <strong className="text-fg">Complain (s.13).</strong> To our Grievance
              Officer first, and to the Data Protection Board of India if we do not sort it
              out.
            </>,
          ]}
        />
        <div className="flex flex-wrap gap-3 pt-2">
          <Link
            to="/contact?kind=access"
            className="rounded-full border-2 border-ink-600 bg-ink-800 px-5 py-2.5 text-small font-medium text-fg transition-colors duration-[160ms] hover:border-ink-500 hover:bg-ink-750"
          >
            Make a data-rights request
          </Link>
          <Link
            to="/app/privacy"
            className="rounded-full border-2 border-white/40 px-5 py-2.5 text-small font-medium text-fg transition-colors duration-[160ms] hover:border-white/70 hover:bg-white/[0.06]"
          >
            Signed in? Do it yourself now
          </Link>
        </div>
        {notice && (
          <p className="text-fg-subtle">
            We answer within {notice.rights_response_days} days. If you are not signed in
            we verify who you are first, because otherwise anyone who knows your email
            address could ask us to delete your account.
          </p>
        )}
      </Clause>

      <Clause id="security" n="8" title="How it is protected, and where it is thin">
        <p>
          {/*
            The substance stays — a security section is expected in a privacy notice and
            DPDP s.8(5) requires reasonable safeguards to be stated. What has gone is the
            implementation vocabulary and the mention of internal tooling. Saying
            passwords are unreadable is a promise; naming the mechanism is a detail for us.
          */}
          Passwords are never stored in a readable form. Signing in uses a cookie that
          scripts on the page cannot read, and every action that changes something is
          protected against being triggered from another site. Actions that move money
          need the password typed again. Downloads use short-lived private links rather
          than guessable addresses.
        </p>
        <p>
          What is not yet true, stated because a security section that only lists
          strengths is marketing:
        </p>
        <Bullets
          items={[
            <>
              Stored files are <strong className="text-fg">not encrypted at rest</strong>{' '}
              by us beyond whatever the underlying disk provides.
            </>,
            <>
              There is <strong className="text-fg">no captcha</strong> on the public
              forms. They are rate limited per IP instead.
            </>,
            <>
              HTTPS, the secure-cookie flag and HSTS are deployment configuration and{' '}
              <strong className="text-fg">must be on before this site takes real users</strong>.
            </>,
          ]}
        />
        <p>
          These are tracked as open items in our own compliance record rather than left
          for someone else to find.
        </p>
      </Clause>

      <Clause id="children" n="9" title="Children">
        <p>
          The service is not for anyone under 18. DPDP s.9 requires verifiable parental
          consent for a child&rsquo;s data and forbids tracking or targeted advertising at
          children; we do no tracking or advertising at all, and we do not knowingly
          process a child&rsquo;s data. If you believe we hold a child&rsquo;s data, tell
          the Grievance Officer and we will delete it.
        </p>
        <p className="text-fg-subtle">
          LEGAL REVIEW: no age verification is implemented. Whether the current position
          is sufficient needs an opinion.
        </p>
      </Clause>

      <Clause id="breach" n="10" title="If something goes wrong">
        <p>
          If personal data is exposed, we notify the Data Protection Board of India and
          every affected person. We have a written procedure for it, including who does
          what and inside what time, so the answer to &ldquo;what now&rdquo; is not
          invented on the day.
        </p>
      </Clause>

      <Clause id="changes" n="11" title="Changes to this notice">
        <p>
          The notice carries a version, and that version is stamped onto every consent
          record. So we can always say which text you agreed to, and when it changes we
          ask again rather than assuming your old agreement covers the new terms.
        </p>
      </Clause>

      <Clause id="grievance" n="12" title="How to reach us">
        {/*
          Warns when no officer has been appointed, unlike the footer, which stays
          silent. A reader of the Privacy Notice is entitled to know the grievance
          route is not published yet — on this page that absence is information, not
          noise.
        */}
        <GrievanceBlock />
        <p>
          Anything at all:{' '}
          <Link to="/contact" className="text-fg underline underline-offset-2">
            the contact form
          </Link>
          . It reaches the same inbox and is answered by a person.
        </p>
        <p>
          If we do not resolve your complaint, you can escalate to the{' '}
          <strong className="text-fg">Data Protection Board of India</strong> under DPDP
          s.13(3).
        </p>
      </Clause>
    </LegalPage>
  );
}
