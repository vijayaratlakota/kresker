/**
 * Email address IDENTITY: when are two addresses the same inbox, and is it throwaway.
 *
 * The free plan is one lifetime minute per `user_id`, and the only thing standing in
 * front of farming it is the confirmation gate — which was worth almost nothing while
 * john@gmail.com, john+1@gmail.com, j.o.hn@gmail.com and john@googlemail.com were four
 * accounts whose confirmation links all landed in ONE inbox. `normalise` makes those
 * four one account.
 *
 * It is not proof of identity and is not meant to be. Several genuine inboxes at several
 * providers still get several accounts; the point is "costs real effort per account".
 *
 * MUST AGREE WITH THE PYTHON VERSION BYTE FOR BYTE: `users.email_normalised` is UNIQUE,
 * and a canonicaliser that differed between the two backends would let one inbox hold
 * two accounts depending on which backend registered them.
 */
import { pyStrip } from './py';

/** Domains that are the same provider under two names. Folded before the local rules. */
const DOMAIN_ALIASES: Record<string, string> = {
  'googlemail.com': 'gmail.com',
  // Microsoft's consumer domains are separate mailboxes, NOT aliases: hotmail.com and
  // outlook.com can be held by different people.
};

/**
 * Providers where dots in the local part do not matter. GMAIL ONLY: almost everywhere
 * else `first.last@company.com` and `firstlast@company.com` are two colleagues, and
 * folding dots globally would merge two strangers' accounts.
 */
const DOT_FOLDING = new Set(['gmail.com']);

/** RFC 5233 sub-addressing. Stripped for every domain, deliberately. */
const PLUS = '+';

/** (local, domain), lowercased and trimmed, domain aliases folded. Splits on the LAST @. */
export function split(email: string | null | undefined): [string, string] {
  const cleaned = pyStrip(email || '').toLowerCase();
  const at = cleaned.lastIndexOf('@');
  const local = at < 0 ? '' : cleaned.slice(0, at);
  const domain = at < 0 ? cleaned : cleaned.slice(at + 1);
  if (!local) {
    // No usable local part: nothing sensible to split. The request validator rejects
    // this long before it gets here, so this is a guard rather than a path.
    return [cleaned, ''];
  }
  return [local, DOMAIN_ALIASES[domain] ?? domain];
}

/**
 * The canonical form of the address: one string per real INBOX.
 *
 * Used for the uniqueness DECISION only. `users.email` keeps the address as typed,
 * because that is what mail is sent to and what the person recognises.
 */
export function normalise(email: string | null | undefined): string {
  let [local, domain] = split(email);
  if (!domain) return local;

  // Sub-address first: the tag can itself contain dots, which at Gmail belong to the tag.
  local = local.split(PLUS)[0];

  if (DOT_FOLDING.has(domain)) local = local.split('.').join('');

  // Only a tag, e.g. "+tag@gmail.com": keep the original rather than a bare "@domain",
  // which would collide with every other such address.
  if (!local) [local] = split(email);

  return `${local}@${domain}`;
}

// ── throwaway inboxes ────────────────────────────────────────────────────────
//
// A curated list, and a weak signal that ages badly. RFC 2606 reserved names are NOT
// here: they cannot receive mail, so the confirmation gate already handles them, and
// every internal test suite registers on example.com.
const DISPOSABLE = new Set([
  '0-mail.com', '10minutemail.com', '10minutemail.net', '20minutemail.com',
  '33mail.com', 'dispostable.com', 'disposablemail.com', 'email-fake.com',
  'emailondeck.com', 'emailtemporanea.net', 'fakeinbox.com', 'fakemailgenerator.com',
  'getairmail.com', 'getnada.com', 'grr.la', 'guerrillamail.biz',
  'guerrillamail.com', 'guerrillamail.de', 'guerrillamail.net', 'guerrillamail.org',
  'guerrillamailblock.com', 'harakirimail.com', 'inboxbear.com', 'inboxkitten.com',
  'jetable.org', 'linshiyouxiang.net', 'luxusmail.org', 'mailbox52.gq',
  'maildrop.cc', 'maileasy.fr', 'mailinator.com', 'mailinator.net', 'mailnesia.com',
  'mailsac.com', 'mailtemp.info', 'mintemail.com', 'moakt.com', 'mohmal.com',
  'mytemp.email', 'nada.email', 'nowmymail.com', 'sharklasers.com', 'spam4.me',
  'spamgourmet.com', 'temp-mail.io', 'temp-mail.org', 'tempail.com', 'tempinbox.com',
  'tempm.com', 'tempmail.net', 'tempmail.plus', 'tempmailo.com', 'tempr.email',
  'throwawaymail.com', 'trashmail.com', 'trashmail.de', 'trashmail.me',
  'trbvm.com', 'tmpmail.org', 'wegwerfmail.de', 'yopmail.com', 'yopmail.fr',
  'yopmail.net',
]);

function envDomains(name: string): Set<string> {
  return new Set(
    (process.env[name] || '')
      .split(',')
      .filter((d) => pyStrip(d))
      .map((d) => pyStrip(d).toLowerCase().replace(/^@+/, '')),
  );
}

/** Operator additions and removals, so a false positive does not need a deploy. */
const EXTRA = envDomains('VS_DISPOSABLE_EXTRA');
/** The allowlist wins: a real customer refused at signup is somebody waiting on it. */
const ALLOW = envDomains('VS_DISPOSABLE_ALLOW');

/** Whether the check refuses the registration at all. */
export const ENFORCE_DISPOSABLE = (process.env.VS_BLOCK_DISPOSABLE || '1') === '1';

/** `a.b.mailinator.com` -> itself, `b.mailinator.com`, `mailinator.com`, `com`. */
function domainChain(domain: string): string[] {
  const parts = domain.split('.').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join('.'));
  return out;
}

/** True when the domain, or any parent of it, is a known throwaway provider. */
export function isDisposable(email: string): boolean {
  const [, domain] = split(email);
  if (!domain) return false;
  const chain = domainChain(domain);
  if (chain.some((d) => ALLOW.has(d))) return false;
  return chain.some((d) => DISPOSABLE.has(d) || EXTRA.has(d));
}

/** What the module is enforcing, for the admin panel. */
export function describe(): Record<string, unknown> {
  return {
    disposable_domains_builtin: DISPOSABLE.size,
    disposable_domains_extra: [...EXTRA].sort(),
    disposable_allowed: [...ALLOW].sort(),
    enforced: ENFORCE_DISPOSABLE,
    dot_folding_domains: [...DOT_FOLDING].sort(),
    domain_aliases: { ...DOMAIN_ALIASES },
    note:
      'normalise() decides whether two addresses are one inbox; the stored ' +
      'email is always the address as typed',
  };
}
