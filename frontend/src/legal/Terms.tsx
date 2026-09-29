/**
 * Terms of Service.
 *
 * There was no Terms page in this codebase, so the brief's "add a data-protection
 * clause to Terms" needed a Terms to add it to. §8 is that clause; the rest is the
 * minimum a paid service needs around it so §8 is not floating on its own.
 *
 * LEGAL REVIEW: the whole page. This is a description of how the product behaves,
 * written in the shape of terms. It is not a lawyer's draft, and the liability,
 * governing-law and refund clauses in particular need one.
 */
import { Link } from 'react-router-dom';
import { Bullets, Clause, LegalPage } from './LegalPage';
import { useNotice } from './useNotice';

export function Terms() {
  const { notice } = useNotice();

  return (
    <LegalPage
      title="Terms of Service"
      lede="The agreement between you and us. Short, and in the same language as the rest of the site."
      updated={notice ? `Aligned with notice version ${notice.notice_version}` : undefined}
      review
    >
      <Clause id="agreement" n="1" title="The agreement">
        <p>
          By creating an account or uploading a video you accept these Terms and the{' '}
          <Link to="/privacy" className="text-fg underline underline-offset-2">
            Privacy Notice
          </Link>
          . If you do not, do not use the service — there is no version of this where you
          use it and these do not apply.
        </p>
        <p className="text-fg-subtle">
          LEGAL REVIEW: insert the contracting entity, its registered address and the
          governing law and venue.
        </p>
      </Clause>

      <Clause id="what" n="2" title="What we provide">
        <p>
          You upload a video. We transcribe the speech, translate it, generate speech in
          the target language using a voice model derived from the speakers in your own
          file, and return a dubbed video. Minutes are counted against the plan you are
          on.
        </p>
        <p>
          It is automated. There is no human review of your content, no editorial pass,
          and no guarantee that a particular line reads the way you would have written
          it. See the{' '}
          <Link to="/disclaimer" className="text-fg underline underline-offset-2">
            Disclaimer
          </Link>{' '}
          for what that means in practice.
        </p>
      </Clause>

      <Clause id="your-content" n="3" title="Your content, and the rights you must have in it">
        <p>
          Your video stays yours. We claim no ownership of anything you upload and no
          ownership of the dub we produce from it. We do not use your videos, your
          transcripts or your voice clips to train models — not ours, and we do not
          license them to anyone else for training.
        </p>
        <p>
          What you have to promise us is narrower and more important than usual, because
          this service copies people&rsquo;s voices:
        </p>
        <Bullets
          items={[
            <>
              You own the video, or you have permission from whoever does.
            </>,
            <>
              <strong className="text-fg">
                You have the right to submit every voice in the file
              </strong>
              , including anybody who is not you. A voice is personal data about the person
              it belongs to. If your video has three speakers, you are telling us you may
              lawfully have all three of them cloned.
            </>,
            <>
              The content is lawful: not defamatory, not infringing, not obscene, not
              produced to impersonate someone or to deceive anyone about who said what.
            </>,
          ]}
        />
        <p>
          You give us a licence to process your video only for the purpose of dubbing it
          and delivering the result to you. That licence ends when the files are deleted.
        </p>
      </Clause>

      <Clause id="dont" n="4" title="What you must not do with it">
        <Bullets
          items={[
            'Clone somebody’s voice without their permission.',
            'Make anyone appear to say something they did not say, in any language.',
            'Upload content involving minors in any sexual, exploitative or abusive context. This is the one thing where a single instance ends the account and is reported.',
            'Use it for fraud, harassment, or to impersonate a real person or organisation.',
            'Resell the raw output as your own dubbing service, or resell access to the account.',
            'Attempt to work around minute limits, rate limits or the payment flow, or to reach parts of the system that are not yours.',
          ]}
        />
        <p>
          We can suspend or close an account for any of these. Where we can, we will tell
          you which one and why.
        </p>
      </Clause>

      <Clause id="plans" n="5" title="Plans, minutes and payment">
        <p>
          Plans are prepaid and priced in minutes of video. Minutes are charged when a dub
          is queued, and refunded automatically when a dub fails on our side. Payment is
          taken by Razorpay; we never see your card or UPI details.
        </p>
        <p>
          A subscription renews only if it says it renews, and you can cancel it at any
          time from the billing page — cancelling keeps your access until the end of the
          period you already paid for.
        </p>
        <p className="text-fg-subtle">
          LEGAL REVIEW: refund policy, chargeback handling and tax treatment need to be
          stated here explicitly.
        </p>
      </Clause>

      <Clause id="retention" n="6" title="How long we keep your files">
        {notice ? (
          <p>
            Dubbed videos are deleted automatically:{' '}
            {notice.retention.dubbed_output_free_hours} hours after completion on the free
            plan, {notice.retention.dubbed_output_paid_days} days on a paid plan. You can
            delete one sooner from your library. Download it before then — we are not a
            storage service, and a deleted output is gone rather than archived.
          </p>
        ) : (
          <p>
            Dubbed videos are deleted automatically after a period that depends on your
            plan. Download them before then.
          </p>
        )}
      </Clause>

      <Clause id="availability" n="7" title="Availability">
        <p>
          Dubbing capacity is started when work arrives and wound down when it is idle,
          which is what keeps the price where it is. So the first job after a quiet period
          takes several minutes longer to start. We do not offer an
          uptime guarantee or an SLA, and we will take the service down for maintenance
          when we need to.
        </p>
      </Clause>

      {/* ── the clause the brief asked for ───────────────────────────────── */}
      <Clause id="data-protection" n="8" title="Data protection">
        <p>
          This clause is part of the agreement, not a summary of the Privacy Notice. It
          exists so the obligations are contractual rather than only descriptive.
        </p>
        <Bullets
          items={[
            <>
              <strong className="text-fg">Our role.</strong> For personal data in your
              account and in the videos you upload, we act as the{' '}
              <em>Data Fiduciary</em> under the Digital Personal Data Protection Act, 2023,
              and you act as the <em>Data Principal</em>. Where your video contains other
              people, you are responsible for having a lawful basis to submit their data to
              us, and we process it on the footing that you do.
            </>,
            <>
              <strong className="text-fg">Purpose limitation.</strong> We process your
              content only to produce the dub you asked for and to deliver it to you. We
              do not use it to train models, we do not mine it for anything, and we do not
              disclose it except to the recipients listed in the{' '}
              <Link to="/privacy#who-else" className="text-fg underline underline-offset-2">
                Privacy Notice §5
              </Link>{' '}
              or where a law compels us.
            </>,
            <>
              <strong className="text-fg">Consent, and withdrawing it.</strong> Consent is
              recorded per purpose, at the point of collection, against the version of the
              notice you were shown. For the processing the service depends on, creating an
              account and uploading a file are the acts of consent, and the notice is
              linked beside both. Anything optional is never bundled into those: it starts
              off, it is switched on only by a deliberate act on your privacy page or in
              the privacy banner, and it can be withdrawn at any time with no effect on the
              service. Withdrawing consent for the processing the service depends on means
              closing the account.
            </>,
            <>
              <strong className="text-fg">Your rights.</strong> Access, correction, erasure
              and grievance redressal as set out in{' '}
              <Link to="/privacy#rights" className="text-fg underline underline-offset-2">
                Privacy Notice §7
              </Link>
              . We answer within{' '}
              {notice ? notice.rights_response_days : 30} days. There is no charge and you
              need not give a reason.
            </>,
            <>
              <strong className="text-fg">Retention and deletion.</strong> Outputs are
              deleted on the timer for your plan. On account closure we erase your personal
              data and de-link the financial records we are required to keep, and we tell
              you itemised what was deleted and what was retained.
            </>,
            <>
              <strong className="text-fg">Security.</strong> We apply reasonable technical
              and organisational safeguards as required by DPDP s.8(5), and the Privacy
              Notice states honestly which ones are in place and which are outstanding.
            </>,
            <>
              <strong className="text-fg">Breach notification.</strong> If personal data is
              exposed we notify the Data Protection Board of India and every affected
              person, following a written procedure held with our engineering
              documentation.
            </>,
            <>
              <strong className="text-fg">Grievances.</strong> Our Grievance Officer is
              published in the{' '}
              <Link to="/privacy#grievance" className="text-fg underline underline-offset-2">
                Privacy Notice §12
              </Link>{' '}
              and in the footer of every page. You may escalate to the Data Protection
              Board of India under s.13(3).
            </>,
            <>
              <strong className="text-fg">Sub-processors.</strong> We may change the
              services listed in Privacy Notice §5. When a change materially affects what
              happens to your data we bump the notice version, which asks for your consent
              again rather than assuming it.
            </>,
          ]}
        />
      </Clause>

      <Clause id="liability" n="9" title="Liability">
        <p>
          The service is provided as it is. To the extent the law allows, we are not
          liable for indirect or consequential loss, for lost profit or goodwill, or for
          any decision you take on the strength of a machine translation. Where liability
          cannot be excluded, it is limited to what you paid us in the twelve months
          before the claim.
        </p>
        <p>
          Nothing here limits liability for anything that cannot lawfully be limited.
        </p>
        <p className="text-fg-subtle">LEGAL REVIEW: this clause specifically.</p>
      </Clause>

      <Clause id="ending" n="10" title="Ending it">
        <p>
          You can close your account whenever you like, and closing it erases your data as
          described above. We can suspend or close an account that breaches these Terms.
          Unused prepaid minutes are not refundable on a closure for breach.
        </p>
      </Clause>

      <Clause id="changes" n="11" title="Changes">
        <p>
          We will post changes here and, where they matter, bump the notice version so you
          are asked again rather than assumed to have agreed. Continuing to use the service
          after a change means you accept it.
        </p>
      </Clause>
    </LegalPage>
  );
}
