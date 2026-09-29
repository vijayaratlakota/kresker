/**
 * The landing page.
 *
 * Motion budget: this is a page most visitors see once, which is the tier the
 * `animate` skill allows delight on. Everything here is a scroll reveal that fires
 * once, plus staggered entrances. Nothing loops except the logo marquee, and that
 * pauses on hover.
 */
import { Accordion } from '@base-ui/react/accordion';
import clsx from 'clsx';
import { Link } from 'react-router-dom';
import { Button, Chevron } from '../ui/Button';
import { Card, Reveal, Shell } from '../ui/primitives';
import { LANGUAGES } from '../lib/format';
import { LanguageSwitcher } from './LanguageSwitcher';
import { Nav } from './Nav';
import { DashboardDemo } from './DashboardDemo';
import { DecisionsDemo } from './DecisionsDemo';
import { ReachDemo } from './ReachDemo';
import { Footer } from './Footer';

const STEPS = [
  {
    n: '01',
    title: 'Upload your video',
    body: 'Drop in an MP4 up to 30 minutes. We measure it ourselves rather than trusting the file, and tell you the cost before anything runs.',
  },
  {
    n: '02',
    title: 'Pick the language',
    body: 'That is the only decision. Voice matching, timing and mixing are already set to the settings we tuned — there is nothing to configure and nothing to get wrong.',
  },
  {
    n: '03',
    title: 'Press generate',
    // "Close the tab" used to be its own step, which read as an instruction to do
    // nothing. The reassurance is real and worth keeping, so it moved here as the
    // consequence of pressing the button rather than as a step of its own.
    body: 'One press starts every language you picked. From then on it runs on our side, not in your browser — refresh, crash, go to lunch, and the progress is still there when you come back.',
  },
  {
    n: '04',
    title: 'Download the dub',
    body: 'One video file per language, with the dubbed track as its default audio and labelled so players show it properly. Unlimited downloads while it lasts.',
  },
];

const FAQ = [
  {
    q: 'Does it keep the original speaker’s voice?',
    a: 'Yes. We clone each speaker from their own audio in your video and then speak the translation in that voice. Speakers with under about two seconds of clean speech cannot be cloned reliably — when that happens we tell you which line it was rather than quietly substituting a stranger.',
  },
  {
    q: 'Will the dub stay in sync with the picture?',
    a: 'Each translated line is fitted into the original line’s exact time slot, and we verify afterwards that the video timeline is unchanged. Your footage is never stretched or retimed to make the audio fit.',
  },
  {
    q: 'What happens if I close the browser mid-job?',
    a: 'Nothing. The work does not run in your browser, and every stage is saved as it completes. Reopen the dashboard on any device and the dub is exactly where you left it.',
  },
  {
    q: 'How long does a dub take?',
    a: 'Roughly five to eighteen times the length of the video, depending on how many separate lines it contains. A 30-second clip is a few minutes; a three-minute video can be closer to an hour. We show a live estimate rather than a spinner.',
  },
  {
    q: 'How long do you keep my video?',
    a: 'Twenty-four hours on the free plan, seven days on a paid plan, then it is deleted automatically. You can also delete it yourself at any time. We show the exact date, not a countdown, so there is no ambiguity.',
  },
  {
    q: 'What do I actually get back?',
    a: 'A single MP4 with one audio track — the dub — set as the default and tagged with the language. The original audio is not bundled alongside it, so the file plays dubbed everywhere without anyone choosing a track.',
  },
];

export function Landing() {
  return (
    <div className="min-h-dvh bg-ink-950">
      <Nav />

      {/* ── hero ─────────────────────────────────────────────────────────── */}
      <section className="hero-top relative overflow-hidden pb-16 sm:pb-24">
        {/* `bg-grid-mask` carries BOTH masks: the original radial fade, plus a clearance
            for the top strip on phones. See the note on it in styles.css — they have to
            be composited, because a second `mask-image` would have replaced the radial
            one and quietly removed the fade. */}
        <div className="bg-grid bg-grid-mask pointer-events-none absolute inset-0" />
        {/* White light, not a brand colour. A tinted wash behind a headline sets
            the temperature of the whole page.

            `top-strip-clear` masks it out of the first 4.5rem on a phone, fading it in
            over the next 4rem. The offset is back to the original `-20rem` at every
            width, because the mask now guarantees the clearance rather than the ellipse's
            geometry happening to land in the right place.

            WHY THE TOP HAS TO BE LEFT ALONE: while Safari's toolbars are expanded, the
            web view does not reach the status bar, and Safari fills that strip with the
            `theme-color` meta value — a single FLAT colour. So the join is only invisible
            if the top of our page is that same flat #08090b. A glow bleeding into the
            first few rem lifts it a few values above flat, and the boundary against the
            strip is exactly the "black border" that kept being reported.

            Verified against dododisk.com, which gets this for free: its theme-color is
            #000000 and its background is the same flat #000000, so there is nothing to
            mismatch. */}
        <div className="glow-top top-strip-clear pointer-events-none absolute left-1/2 top-[-20rem] h-[38rem] w-[64rem] -translate-x-1/2" />

        <Shell className="relative">
          <div className="stagger mx-auto max-w-3xl text-center">
            {/*
              The hero, matched to the reference.

              Three things it does that the previous version did not:

              * **Solid white, no gradient.** The old `text-gradient` faded the
                second line to about 60% opacity, which on a two-line heading reads
                as the bottom line being less important. The reference keeps both
                lines the same weight and the same white.
              * **A chosen line break, not a wrap.** `<br>` at the `sm` breakpoint
                and above. `text-wrap: balance` would split this into two even
                halves; the reference breaks where the SENSE breaks, which is not
                the same place. Below `sm` it wraps naturally, because a forced
                break on a narrow screen produces a ragged orphan.
              * **Line height 1.15.** Measured off the reference rather than
                guessed: two lines, cap-to-cap, at roughly 1.17.

              The breakpoint sizes are the only responsive type overrides in the
              app — everything else takes size, weight and tracking from the scale.

              The word "language" was briefly a slot cycling through every script we
              dub into. It is static again: the scripts have very different widths
              and heights, so the slot had to be pinned to the widest of them, which
              left a visible gap after the short ones and made the centred heading
              look off-balance. The reel below already demonstrates the languages,
              with audio, which is a stronger argument than the word changing.
            */}
            <h1 className="text-h1 sm:text-[3.5rem] md:text-display">
              Your video, speaking
              <br className="hidden sm:block" /> every language
            </h1>

            {/*
              The sub-heading. In the reference this is visibly lighter than the
              headline, and it gets that from a lower WEIGHT. We have a single
              weight — the supplied file is Bold only — so the hierarchy comes from
              size and colour instead: 18px against 64px, and muted grey against
              white. Same read, one font file.

              max-width is set in `ch` rather than a Tailwind step so the measure
              is tied to the text, landing it on two balanced lines the way the
              reference does instead of wherever 36rem happens to fall.
            */}
            <p className="mx-auto mt-6 max-w-[62ch] text-pretty text-lead text-fg-muted">
              Kresker dubs your video into another language and keeps the speaker’s own
              voice. Upload, pick a language, and get the finished file back.
            </p>

            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Link to="/signup">
                <Button size="lg" variant="iris">Dub your first video free</Button>
              </Link>
              <a href="#how">
                {/*
                  White pill with a trailing chevron. The chevron is doing real
                  work here: this is the one CTA that moves you down the page
                  rather than out of it, and the arrow says so before the label is
                  read.
                */}
                <Button size="lg" variant="primary">
                  See how it works
                  <Chevron />
                </Button>
              </a>
            </div>

            <p className="mt-4 text-tiny text-fg-subtle">
              One free minute, no card. Nothing renews on its own.
            </p>
          </div>

          <Reveal className="mx-auto mt-16 max-w-4xl" delay={80}>
            <LanguageSwitcher />
          </Reveal>
        </Shell>
      </section>

      {/* ── the numbers ──────────────────────────────────────────────────── */}
      <section className="border-t border-ink-700 py-14">
        <Shell>
          {/*
            `gap-x-4` added: there was only `gap-y-10`, so at two columns on a phone the
            two cells touched. Each `<dt>` is `text-h2` (40px) in a ~160px column, and
            with no horizontal gap "43" and "30 min" ran into each other.

            The values also step down a size below sm. 40px numerals in a 160px column
            with a 22ch note underneath is more weight than the column can carry.
          */}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-10 sm:grid-cols-4">
            {[
              // Read off the catalogue rather than typed. A hand-written number here
              // was already one language behind reality the moment the list grew, and
              // a marketing page that undercounts the product is a strange thing to
              // maintain by hand.
              [String(LANGUAGES.length), 'languages', 'Indian, European and Asian, on every plan'],
              ['30 min', 'longest video', 'per job, on a paid plan'],
              ['1 click', 'to start', 'language is the only thing you pick'],
              ['0', 'settings to tune', 'every dub uses the same tuned setup'],
            ].map(([value, label, note]) => (
              <div key={label} className="text-center">
                <dt className="text-h3 tabular-nums leading-none sm:text-h2">{value}</dt>
                <dd className="mt-2.5 text-small text-fg">{label}</dd>
                <dd className="mx-auto mt-1 max-w-[22ch] text-tiny text-fg-subtle">
                  {note}
                </dd>
              </div>
            ))}
          </dl>
        </Shell>
      </section>

      {/* ── language marquee ─────────────────────────────────────────────── */}
      <section id="languages" className="border-y border-ink-700 bg-ink-900/50 py-10">
        <p className="mb-6 text-center text-tiny uppercase tracking-[0.18em] text-fg-subtle">
          Dubs into
        </p>
        {/*
          A LINK OUT OF THE MARQUEE, and it is doing real work rather than being a
          courtesy.

          The marquee reads well and cannot be quoted — it is a scrolling row of chips,
          with no structure a search engine or an AI answer can extract. The /languages
          page carries the same catalogue as two real tables with native scripts and
          regions, which is the form that gets cited.

          This link is also the only path to that page from the body of the homepage.
          The nav and footer both point at it, but a link inside the section that raises
          the question is the one a reader actually follows.
        */}
        <div className="marquee-host relative overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]">
          <div className="marquee flex w-max gap-3">
            {[...LANGUAGES, ...LANGUAGES].map((l, i) => (
              <span
                key={`${l.code}-${i}`}
                className="rounded-full border border-ink-700 bg-ink-850 px-5 py-2 text-body text-fg-muted"
              >
                <span className="text-fg">{l.native}</span>
                <span className="ml-2 text-fg-subtle">{l.label}</span>
              </span>
            ))}
          </div>
        </div>
        <p className="mt-6 text-center text-small text-fg-muted">
          <Link
            to="/languages"
            data-touch-target
            className="inline-flex items-center rounded-lg px-3 py-2 text-fg underline decoration-ink-600 underline-offset-4 transition-colors duration-[160ms] hover:decoration-fg"
          >
            See all {LANGUAGES.length} languages, with scripts and regions
          </Link>
        </p>
      </section>

      {/* ── how it works ─────────────────────────────────────────────────── */}
      <section id="how" className="py-24">
        <Shell>
          <Reveal>
            <p className="text-tiny uppercase tracking-[0.18em] text-fg">
              How it works
            </p>
            <h2 className="mt-3 max-w-2xl text-balance text-h2 sm:text-h1">
              Four steps, and only one of them is yours
            </h2>
          </Reveal>

          {/*
            The mockup and the words sit side by side rather than the mockup
            replacing the words. The animation loops every twenty seconds, and
            somebody who arrives mid-cycle should not have to wait to find out what
            step two is — the text is the source of truth, the mockup shows it.
          */}
          <div className="mt-14 grid items-start gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
            <Reveal>
              <DashboardDemo />
              <p className="mt-3 text-center text-tiny text-fg-subtle">
                The real dashboard, running the four steps. No settings to touch.
              </p>
            </Reveal>

            <ol className="grid gap-3">
              {STEPS.map((s, i) => (
                <Reveal key={s.n} delay={i * 70} as="li">
                  <Card
                    className={clsx(
                      'h-full p-5',
                      'transition-[border-color,background-color] duration-[250ms]',
                      'ease-[var(--ease-out-strong)] hover:border-ink-750 hover:bg-ink-800',
                    )}
                  >
                    <div className="flex items-baseline gap-2.5">
                      <span className="font-mono text-small text-fg-subtle">{s.n}</span>
                      <h3 className="text-h5">{s.title}</h3>
                    </div>
                    <p className="mt-1.5 text-small leading-relaxed text-fg-muted">
                      {s.body}
                    </p>
                  </Card>
                </Reveal>
              ))}
            </ol>
          </div>
        </Shell>
      </section>

      {/* ── what one click actually replaces ─────────────────────────────── */}
      <section className="border-t border-ink-700 py-24">
        <Shell>
          <Reveal>
            <p className="text-tiny uppercase tracking-[0.18em] text-fg-subtle">
              Nothing to configure
            </p>
            <h2 className="mt-3 max-w-2xl text-balance text-h2 sm:text-h1">
              Every decision already made, and written down
            </h2>
            <p className="mt-5 max-w-2xl text-lead text-fg-muted">
              These are the choices a dubbing tool normally hands you. We made them
              once, pinned them, and stamp the exact settings onto every job — so any
              dub can be traced back to what produced it.
            </p>
          </Reveal>

          {/*
            This replaced a five-row table of the same five claims with green ticks
            beside them. Both were saying the same thing, and the table was the
            weaker half: "Each line fitted to its original slot" is a phrase every
            dubbing tool prints, so as text it carries no information. Shown as a
            dubbed line landing inside a slot that does not move, it is checkable.
            The claims moved into the explainer's own header, so the sentence and the
            demonstration are read together.
          */}
          <Reveal className="mt-12" delay={60}>
            <DecisionsDemo />
          </Reveal>
        </Shell>
      </section>

      {/* ── the creator play: one video, one URL, every language ──────────
          Replaced "Built so a refresh costs you nothing", which was a paragraph
          about our database architecture beside a four-row list of the same claim.
          It answered a question nobody browsing a dubbing site is asking, and the
          FAQ already answers it for the one person who is.

          What goes here instead is the reason a creator would buy this at all. */}
      <section id="reach" className="border-y border-ink-700 bg-ink-900/40 py-24">
        <Shell>
          <Reveal>
            <p className="text-tiny uppercase tracking-[0.18em] text-fg-subtle">
              For creators
            </p>
            <h2 className="mt-3 max-w-3xl text-balance text-h2 sm:text-h1">
              One video. Every language.{' '}
              <span className="text-gradient">The same URL.</span>
            </h2>
            <div className="mt-5 grid max-w-4xl gap-6 lg:grid-cols-2">
              <p className="text-lead leading-relaxed text-fg-muted">
                YouTube lets you attach an audio track per language to a video you have
                already posted. Not a re-upload, not a second channel — the{' '}
                <span className="text-fg">same video</span>, and a viewer in Chennai
                hears Tamil while a viewer in Madrid hears Spanish. Your views, watch
                time and comments all land in one place.
              </p>
              <p className="text-lead leading-relaxed text-fg-muted">
                This is the play MrBeast is known for. He ran separate dubbed channels
                for years; multi-language audio collapsed all of it into one video.{' '}
                <span className="text-fg">
                  More languages is more reach, and reach is the only input the
                  algorithm really has.
                </span>
              </p>
            </div>
          </Reveal>

          <Reveal className="mt-12" delay={60}>
            <ReachDemo />
          </Reveal>

          <Reveal className="mt-8" delay={120}>
            <div className="grid gap-4 sm:grid-cols-3">
              {[
                {
                  k: 'What you get back',
                  v: 'One dubbed video per language, plus the dubbed track on its own as an .m4a — which is the file YouTube’s audio-track uploader asks for.',
                },
                {
                  k: 'Why it is accepted',
                  v: 'YouTube rejects a track whose length does not match the video. We never retime your picture, and we measure the track against it before handing it over.',
                },
                {
                  k: 'Why it sounds like you',
                  v: 'The dub is your own voice, cloned from your own audio. YouTube’s built-in auto-dubbing gives you a synthetic reader instead.',
                },
              ].map((c) => (
                <Card key={c.k} className="p-5">
                  <p className="text-body font-medium">{c.k}</p>
                  <p className="mt-2 text-small leading-relaxed text-fg-subtle">{c.v}</p>
                </Card>
              ))}
            </div>
          </Reveal>
        </Shell>
      </section>

      {/* ── faq ──────────────────────────────────────────────────────────── */}
      <section id="faq" className="py-24">
        <Shell>
          <div className="grid gap-12 lg:grid-cols-[minmax(0,340px)_1fr]">
            <Reveal>
              <h2 className="text-balance text-h2 sm:text-h1">
                Frequently asked questions
              </h2>
              <p className="mt-4 text-body text-fg-muted">
                Straight answers, including the limits.
              </p>
            </Reveal>

            <Reveal delay={80}>
              {/*
                THE FIRST ANSWER IS OPEN ON LOAD, and that is an SEO decision as much
                as a design one.

                Every answer is in the HTML either way, so nothing was hidden from a
                crawler. But Google's own page-experience guidance — quoted in the
                claude-seo audit — is that content behind an expandable section is
                *less likely to qualify* as a page's primary content, and it asks for
                key content to be immediately visible on load. Six collapsed panels
                meant the single most-asked question about this product ("does it keep
                the original voice?") was, as far as that heuristic is concerned, not
                on the page.

                ONE open, not all six. Opening everything would push the closing CTA
                about two screens down and turn a scannable list into a wall — the
                accordion is earning its place for questions two through six. The
                first is the one everybody has.

                `value` on each item is required for `defaultValue` to identify one:
                without it Base UI falls back to the item's index, which silently
                changes meaning the moment a question is inserted above it. Keyed on
                the question text, which is already the React key.
              */}
              <Accordion.Root
                defaultValue={[FAQ[0].q]}
                className="divide-y divide-ink-700 border-y border-ink-700"
              >
                {FAQ.map((item) => (
                  <Accordion.Item key={item.q} value={item.q} className="group">
                    <Accordion.Header>
                      <Accordion.Trigger
                        className={clsx(
                          'flex w-full items-center justify-between gap-6 py-5 text-left',
                          'transition-colors duration-[160ms] ease-[var(--ease-out-strong)]',
                          'hover:text-fg',
                        )}
                      >
                        <span className="text-lead font-medium">{item.q}</span>
                        <svg
                          viewBox="0 0 24 24"
                          className={clsx(
                            'size-4 shrink-0 text-fg-subtle',
                            'transition-transform duration-[250ms] ease-[var(--ease-out-strong)]',
                            'group-data-[panel-open]:rotate-45 motion-reduce:transition-none',
                          )}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          aria-hidden="true"
                        >
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                      </Accordion.Trigger>
                    </Accordion.Header>
                    {/*
                      Height is the one property the animate skill tolerates
                      animating, because an accordion has no transform equivalent.
                      Kept to 200ms: it costs layout every frame, so a long
                      duration is expensive as well as sluggish. Base UI measures
                      the panel and hands us the value, so we never animate to
                      `auto`.
                    */}
                    <Accordion.Panel
                      className={clsx(
                        'h-[var(--accordion-panel-height)] overflow-hidden',
                        'transition-[height,opacity] duration-[200ms]',
                        'ease-[var(--ease-out-strong)]',
                        'data-[ending-style]:h-0 data-[ending-style]:opacity-0',
                        'data-[starting-style]:h-0 data-[starting-style]:opacity-0',
                        'motion-reduce:transition-none',
                      )}
                    >
                      <p className="pb-5 pr-10 text-body leading-relaxed text-fg-muted">
                        {item.a}
                      </p>
                    </Accordion.Panel>
                  </Accordion.Item>
                ))}
              </Accordion.Root>
            </Reveal>
          </div>
        </Shell>
      </section>

      {/* ── cta ──────────────────────────────────────────────────────────── */}
      <section className="pb-28">
        <Shell>
          <Reveal>
            <Card className="relative overflow-hidden px-8 py-16 text-center">
              <div className="glow-top pointer-events-none absolute inset-x-0 bottom-[-16rem] mx-auto h-[26rem] w-[40rem]" />
              <h2 className="relative text-balance text-h2 sm:text-h1">
                Try it on one video
              </h2>
              <p className="relative mx-auto mt-4 max-w-md text-lead text-fg-muted">
                One minute free, no card, nothing that renews by itself. If the dub is not
                good you have lost a minute of your day.
              </p>
              <div className="relative mt-8 flex justify-center">
                <Link to="/signup">
                  <Button size="lg" variant="iris">Create an account</Button>
                </Link>
              </div>
            </Card>
          </Reveal>
        </Shell>
      </section>

      <Footer />
    </div>
  );
}
