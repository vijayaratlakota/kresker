/**
 * The languages page.
 *
 * ── WHY THIS PAGE EXISTS ─────────────────────────────────────────────────────
 *
 * Three findings from the claude-seo audit converge on it.
 *
 *   1. **The site had zero `<table>` elements.** AI search systems quote tables more
 *      readily than any other structure — comparative data in labelled rows is the
 *      shape they extract best — and a 43-row language list is the most obviously
 *      tabular thing this product has. On the homepage it was a decorative marquee: a
 *      row of chips scrolling past, which reads well and cannot be quoted.
 *
 *   2. **No page existed to answer a question.** All seven pages were "here is our
 *      product" or a legal notice. "What languages does it support" is a real query
 *      with real volume, and the answer lived only inside a picker behind a login.
 *
 *   3. **`hreflang` was empty, and 43 languages were planned.** This is the hub that
 *      per-language pages hang off later. Building the list page first means the
 *      internal linking exists before the leaf pages do, rather than 43 orphans
 *      arriving at once.
 *
 * ── WHAT IT DELIBERATELY IS NOT ──────────────────────────────────────────────
 *
 * It is NOT 43 × 43 = 1,849 language-pair pages, and it is not 43 thin per-language
 * pages either — not yet. Google's scaled-content-abuse policy targets exactly that
 * pattern, and there is no search demand for "Odia to Sinhala dubbing". One page that
 * genuinely answers the question beats forty-three that repeat it with a word swapped.
 *
 * The content is front-loaded on purpose: the answer to "how many and which" is in the
 * first forty words, because roughly 44% of AI citations come from the first 30% of a
 * page.
 */
import { Link } from 'react-router-dom';
import { LANGUAGES, MAX_LANGS_PER_BATCH, type Language } from '../lib/format';
import { INDIAN_LANG_COUNT, LANG_COUNT, LANG_REGIONS, ROUTES } from '../lib/seo';
import { Button } from '../ui/Button';
import { Card, Reveal, Shell } from '../ui/primitives';
import { DataTable } from '../legal/LegalPage';
import { Footer } from './Footer';
import { Nav } from './Nav';

const UPDATED = ROUTES.find((r) => r.path === '/languages')?.updated ?? '';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** "2 September 2026" — spelled out, because 02/09 and 09/02 are different dates. */
function prettyDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const indian = LANGUAGES.filter((l) => l.group === 'india');
const world = LANGUAGES.filter((l) => l.group === 'world');

// `readonly Language[]`, not `typeof indian`. LANGUAGES is `as const`, so `typeof
// indian` is the narrow union of only the fourteen Indian entries — passing the world
// list to the same component then fails to typecheck for a reason that has nothing to
// do with the code being wrong.
function LangTable({ list, caption }: { list: readonly Language[]; caption: string }) {
  return (
    <DataTable
      caption={caption}
      head={['Language', 'In its own script', 'Code', 'Mainly spoken in']}
      rows={list.map((l) => [
        <span className="text-fg">{l.label}</span>,
        // `lang` on the cell, not just decoration: it tells a screen reader to switch
        // voice, and it tells a browser which font to reach for. Without it a Telugu
        // string inside an English document is announced letter by letter in English.
        <span lang={l.code} className="text-fg">
          {l.native}
        </span>,
        <code className="font-mono text-tiny text-fg-subtle">{l.code}</code>,
        LANG_REGIONS[l.code] ?? '',
      ])}
    />
  );
}

export function Languages() {
  return (
    <div className="min-h-dvh bg-ink-950">
      <Nav />

      <section className="relative overflow-hidden pt-32 pb-12 sm:pt-40">
        <div className="bg-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_55%_45%_at_50%_0%,black,transparent)]" />
        <Shell className="relative">
          <div className="max-w-3xl">
            <h1 className="text-balance text-h1 sm:text-display">
              Every language Kresker dubs into
            </h1>
            {/*
              THE ANSWER, IN THE FIRST FORTY WORDS. Not an introduction to the answer —
              the answer. This is the passage an AI system will lift if it cites this
              page, and it has to be true standing on its own, with no surrounding
              context.
            */}
            <p className="mt-6 max-w-2xl text-lead leading-relaxed text-fg-muted">
              Kresker dubs video into{' '}
              <span className="text-fg">{LANG_COUNT} languages</span> —{' '}
              {INDIAN_LANG_COUNT} Indian and {LANG_COUNT - INDIAN_LANG_COUNT} from the
              rest of the world. Every language is on every plan, including the free one,
              and each dub keeps the original speaker&rsquo;s own voice rather than
              replacing it with a stock reader.
            </p>
          </div>
        </Shell>
      </section>

      <section id="indian" className="border-t border-ink-700 py-16">
        <Shell>
          <Reveal>
            <h2 className="text-balance text-h2">
              {INDIAN_LANG_COUNT} Indian languages
            </h2>
            <p className="mt-4 max-w-2xl text-body leading-relaxed text-fg-muted">
              This is the market Kresker was built for, which is why the list goes past
              the usual four. Odia, Assamese, Nepali and Sinhala are here because a
              creator in Bhubaneswar or Guwahati has the same problem as one in Mumbai
              and fewer tools that take it seriously.
            </p>
          </Reveal>
          <Reveal className="mt-8" delay={60}>
            <LangTable
              list={indian}
              caption={`The ${INDIAN_LANG_COUNT} Indian languages Kresker dubs into, with each name in its own script, its language code, and where it is mainly spoken`}
            />
          </Reveal>
        </Shell>
      </section>

      <section id="world" className="border-t border-ink-700 py-16">
        <Shell>
          <Reveal>
            <h2 className="text-balance text-h2">
              {LANG_COUNT - INDIAN_LANG_COUNT} more, everywhere else
            </h2>
            <p className="mt-4 max-w-2xl text-body leading-relaxed text-fg-muted">
              European, Middle Eastern and East Asian. The same tuned setup runs all of
              them — there is no per-language quality tier and no language that costs
              extra.
            </p>
          </Reveal>
          <Reveal className="mt-8" delay={60}>
            <LangTable
              list={world}
              caption={`The ${LANG_COUNT - INDIAN_LANG_COUNT} non-Indian languages Kresker dubs into, with each name in its own script, its language code, and where it is mainly spoken`}
            />
          </Reveal>
        </Shell>
      </section>

      {/*
        The three questions this page raises, answered on the page rather than left for
        the FAQ. Question-shaped `<h2>`s because that is the shape a search query has.
        No FAQPage schema — Google retired FAQ rich results for all sites on
        7 May 2026, so the markup earns nothing now. The headings still do.
      */}
      <section id="questions" className="border-t border-ink-700 py-16">
        <Shell>
          <div className="grid gap-10 lg:grid-cols-3">
            <Reveal>
              <h2 className="text-h4">Does the accent sound local?</h2>
              <p className="mt-3 text-small leading-relaxed text-fg-muted">
                The voice is the original speaker&rsquo;s, cloned from their own audio,
                so it carries their timbre rather than a native accent for the target
                language. That is the trade: it sounds like the person your audience
                already knows, speaking a language they understand, not like a local
                voice actor.
              </p>
            </Reveal>
            <Reveal delay={60}>
              <h2 className="text-h4">
                How many languages can I do at once?
              </h2>
              <p className="mt-3 text-small leading-relaxed text-fg-muted">
                Up to {MAX_LANGS_PER_BATCH} in a single press. The dubs run one after another on
                the same hardware, so a batch takes as long as the sum of its parts —
                and each language costs its own minutes, because each one is a separate
                dub of the whole video.
              </p>
            </Reveal>
            <Reveal delay={120}>
              <h2 className="text-h4">Can I add one you do not list?</h2>
              <p className="mt-3 text-small leading-relaxed text-fg-muted">
                Sometimes. The dubbing engine is not language-switched — it is
                conditioned on the speaker&rsquo;s audio and the translated text — so the
                limit is translation quality and our own metadata, not the model.{' '}
                <Link to="/contact" className="text-fg underline underline-offset-2">
                  Ask
                </Link>{' '}
                and we will tell you honestly whether it would be any good.
              </p>
            </Reveal>
          </div>
        </Shell>
      </section>

      <section className="pb-24">
        <Shell>
          <Reveal>
            <Card className="relative overflow-hidden px-8 py-14 text-center">
              <div className="glow-top pointer-events-none absolute inset-x-0 bottom-[-16rem] mx-auto h-[26rem] w-[40rem]" />
              <h2 className="relative text-balance text-h2">
                Try one language, free
              </h2>
              <p className="relative mx-auto mt-4 max-w-md text-lead text-fg-muted">
                One minute, no card, nothing that renews by itself. Pick the language
                that matters most and hear it before you decide.
              </p>
              <div className="relative mt-8 flex flex-wrap justify-center gap-3">
                <Link to="/signup">
                  <Button size="lg" variant="iris">
                    Dub your first video free
                  </Button>
                </Link>
                <Link to="/pricing">
                  <Button size="lg" variant="secondary">
                    See pricing
                  </Button>
                </Link>
              </div>
            </Card>
          </Reveal>

          <p className="mt-10 text-tiny text-fg-subtle">
            Language list last reviewed{' '}
            <time dateTime={UPDATED}>{prettyDate(UPDATED)}</time>. Counted from the
            product&rsquo;s own catalogue, so this page cannot claim a language the
            picker does not offer.
          </p>
        </Shell>
      </section>

      <Footer />
    </div>
  );
}
