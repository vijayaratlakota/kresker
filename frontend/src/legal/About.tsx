/**
 * About.
 *
 * Deliberately free of invented company facts. There is no founding date, no team
 * size, no customer count and no office, because none of those are known to this
 * codebase and a made-up one on an About page is the kind of small lie that
 * undermines the pages either side of it.
 *
 * What it does instead is describe the thing accurately — including the parts most
 * About pages leave out, like the fact that we only run when there is work, and why
 * that is what keeps the price down.
 *
 * It also carries the grievance contact, under "Who we are". That used to sit in the
 * footer of every marketing page as well; this is the one place it belongs.
 *
 * LEGAL REVIEW: the entity details in §5 are placeholders and must be filled in.
 * Under DPDP s.5 the fiduciary has to be identifiable.
 */
import { Link } from 'react-router-dom';
import { Card } from '../ui/primitives';
import { GrievanceBlock } from './Grievance';
import { Bullets, Clause, LegalPage } from './LegalPage';

export function About() {
  return (
    <LegalPage
      title="About Kresker"
      lede="One thing, done properly: a video that speaks another language in the voice of the person who is already in it."
    >
      <Clause id="what" n="1" title="What we built">
        <p>
          Most dubbing either replaces the speaker with a stock voice, or costs enough that
          you only do it for content you already know will pay for itself. We wanted the
          other thing: upload a video, pick languages, get back a dub that still sounds
          like the person who recorded it.
        </p>
        <p>
          Four stages run end to end. The speech is transcribed with its timings. Each line
          is translated to fit the slot it has to sit in, rather than translated freely and
          then jammed in. Each speaker&rsquo;s voice is modelled from their own audio in
          your file. Then the new speech is generated and laid back over the original
          video, with the background audio kept.
        </p>
      </Clause>

      <Clause id="pipeline" n="2" title="The dubbing is ours">
        <p>
          This is not a rebadged version of somebody else&rsquo;s dubbing product. Every
          stage is assembled and tuned by us — fitting each line to its original timing,
          separating speakers, choosing which audio to copy a voice from, repairing drift,
          keeping the background — and the settings are fixed and versioned, so a dub you
          make next month is produced exactly like one you make today.
        </p>
        <p>
          It does call services we did not build, for translation and for speech
          recognition, and those are named in the{' '}
          <Link to="/privacy#who-else" className="text-fg underline underline-offset-2">
            Privacy Notice
          </Link>
          . We would rather say which parts are ours than imply all of it is.
        </p>
      </Clause>

      <Clause id="choices" n="3" title="Three choices worth explaining">
        <Bullets
          items={[
            <>
              <strong className="text-fg">We only run when there is work.</strong> Capacity
              spins up when a dub arrives and winds down when it goes quiet. That is why
              the first dub after a quiet period takes several minutes longer to begin, and
              it is also why the price is what it is. We would rather explain a wait than
              charge you for idle time.
            </>,
            <>
              <strong className="text-fg">Videos are deleted on a timer.</strong> Not as a
              storage limit dressed up as a feature — we genuinely do not want to be
              holding your footage. Download it and it is gone from us.
            </>,
            <>
              <strong className="text-fg">No tracking.</strong> No analytics service, no
              advertising pixel, no session recorder, no third-party fonts. One cookie,
              and it is the one that keeps you signed in. This is unusual enough that
              people assume it is an oversight, so it is worth stating: it is a decision.
            </>,
          ]}
        />
      </Clause>

      <Clause id="privacy" n="4" title="On privacy, since a voice is involved">
        <p>
          A video of a person contains their face and their voice, and a voice clone is
          personal data about whoever it was taken from. That makes this a product where
          privacy is not a compliance chore bolted on at the end.
        </p>
        <p>
          So: consent is recorded separately for each purpose, permanently, against the
          version of the notice you were shown, and you can read your own record. Nothing
          optional is ever switched on by signing up or uploading — it starts off and stays
          off until you turn it on. You can export everything we hold in one click and
          close your account in another. Where our own audit found gaps, they are written
          down in the{' '}
          <Link to="/privacy" className="text-fg underline underline-offset-2">
            Privacy Notice
          </Link>{' '}
          rather than left out of it.
        </p>
        <Card className="border-ink-700 bg-ink-900 px-4 py-3.5">
          <p className="text-small leading-relaxed text-fg-muted">
            If your video has people other than you in it, you need their permission before
            you clone them here. We ask you to confirm that at upload, and we cannot check
            it for you.
          </p>
        </Card>
      </Clause>

      <Clause id="who" n="5" title="Who we are">
        {/*
          THE GRIEVANCE CONTACT LIVES HERE NOW, and this is where it was always supposed
          to be. It used to be printed in the footer of every marketing page as well,
          which put statutory small print above the copyright on the busiest page of the
          site and said the same thing three times over.

          The officer is appointed, so the placeholder line that claimed otherwise has
          gone. What is still genuinely outstanding — the registered entity — is still
          stated, because a section that quietly drops its own gap is worse than one that
          admits it.
        */}
        <GrievanceBlock />
        <p className="mt-6 text-fg-subtle">
          LEGAL REVIEW / TO BE COMPLETED: registered entity name, registration number,
          registered address and jurisdiction. DPDP s.5 requires the Data Fiduciary to be
          identifiable, and those details are not yet published here.
        </p>
        <p>
          Anything at all reaches a person through{' '}
          <Link to="/contact" className="text-fg underline underline-offset-2">
            the contact form
          </Link>
          .
        </p>
      </Clause>
    </LegalPage>
  );
}
