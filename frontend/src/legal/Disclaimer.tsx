/**
 * Disclaimer.
 *
 * The honest version. A machine dub is a machine dub: it is very good and it is not
 * a human translator, and the places where that matters are specific and worth
 * naming rather than hiding behind "as is".
 *
 * LEGAL REVIEW: all of it.
 */
import { Link } from 'react-router-dom';
import { Card } from '../ui/primitives';
import { Bullets, Clause, LegalPage } from './LegalPage';

export function Disclaimer() {
  return (
    <LegalPage
      title="Disclaimer"
      lede="What this tool is good at, what it is not, and where you should not rely on it."
      review
    >
      <Clause id="automated" n="1" title="Everything here is automated">
        <p>
          No human reads your transcript, checks your translation or listens to your dub
          before you get it. Three machine-learning stages run back to back — speech
          recognition, translation, and speech synthesis — and each one can be wrong in
          its own way.
        </p>
        <p>
          The output is a draft of professional quality, not a certified translation. If
          the words carry consequences, have a person who speaks the language check them
          before you publish.
        </p>
      </Clause>

      <Clause id="where-it-slips" n="2" title="Where it slips, specifically">
        <Bullets
          items={[
            <>
              <strong className="text-fg">Names and jargon.</strong> Proper nouns,
              product names, technical terms and anything domain-specific are the most
              likely things to come out wrong.
            </>,
            <>
              <strong className="text-fg">Numbers, dates and money.</strong> Check every
              one. A mistranscribed digit sounds completely natural.
            </>,
            <>
              <strong className="text-fg">Humour, idiom and sarcasm.</strong> Frequently
              flattened into their literal meaning, which can invert the intent.
            </>,
            <>
              <strong className="text-fg">Overlapping speakers.</strong> Crosstalk,
              interruptions and several people at once are the hardest case for both
              transcription and speaker separation.
            </>,
            <>
              <strong className="text-fg">Heavy accents, noise and music.</strong> Accuracy
              drops with the quality of the source audio. A clean recording in, a good dub
              out.
            </>,
            <>
              <strong className="text-fg">Timing.</strong> Translated speech is often
              longer or shorter than the original. We fit each line back into its slot,
              and on a densely-packed line that fit is a compromise.
            </>,
          ]}
        />
      </Clause>

      <Clause id="voice" n="3" title="Cloned voices">
        <p>
          The dub reproduces how the speakers in your video sound. It is a synthetic
          imitation — close, and not the person. It should not be presented as a genuine
          recording of them, and it is not evidence of anything they said.
        </p>
        <Card className="border-warn/35 bg-warn/[0.06] px-4 py-3.5">
          <p className="text-small leading-relaxed text-warn">
            <strong className="font-medium">
              You are responsible for having the right to every voice you upload.
            </strong>{' '}
            A person&rsquo;s voice is their personal data. If your video contains someone
            other than you, you need their permission before you clone them here — see{' '}
            <Link to="/terms#your-content" className="underline underline-offset-2">
              Terms §3
            </Link>
            . We cannot check this for you, and we act on your assurance that you have it.
          </p>
        </Card>
      </Clause>

      <Clause id="no-advice" n="4" title="Not professional advice">
        <p>
          Nothing produced here is legal, medical, financial, safety or regulatory advice,
          and a dub of content that <em>is</em> such advice does not carry the original&rsquo;s
          authority. Do not use machine dubbing for medical instructions, legal notices,
          safety-critical procedures, regulatory filings or anything where a
          mistranslation could hurt someone.
        </p>
      </Clause>

      <Clause id="third-party" n="5" title="Third-party models">
        <p>
          Parts of the dubbing use services we do not build and do not control, listed in{' '}
          <Link to="/privacy#who-else" className="text-fg underline underline-offset-2">
            Privacy Notice §5
          </Link>
          . When one of them changes its model, output quality can change without anything
          changing on our side. We tune and pin what we can and we cannot promise
          identical results forever.
        </p>
      </Clause>

      <Clause id="availability" n="6" title="Availability and your files">
        <p>
          Finished videos are deleted on a timer that depends on your plan, and the
          timer is real. Download what you need. We are a dubbing service, not backup.
        </p>
        <p>
          Capacity winds down when nothing is running, so the first job after a quiet
          spell takes longer to start. That is deliberate, and it is why the pricing works.
        </p>
      </Clause>

      <Clause id="liability" n="7" title="Liability">
        <p>
          Use of the output is your decision and your responsibility. Our liability is
          limited as set out in{' '}
          <Link to="/terms#liability" className="text-fg underline underline-offset-2">
            Terms §9
          </Link>
          .
        </p>
      </Clause>
    </LegalPage>
  );
}
