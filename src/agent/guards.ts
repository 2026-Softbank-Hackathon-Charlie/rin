import path from 'node:path';

export type Verdict = { allow: true } | { allow: false; reason: string };

/** What a Bash command is checked against. */
export type BashContext = {
  /** The requester asked for a merge in this request. */
  mergeAllowed: boolean;
  /** Text of the request that started this run; empty for scheduled runs. */
  request: string;
  /** A scheduled run: nobody asked for it just now, so charlie only reads. */
  scheduled: boolean;
};

const ALLOW: Verdict = { allow: true };
const deny = (reason: string): Verdict => ({ allow: false, reason });

/**
 * Splits a shell line into simple commands at ; && || | & and newlines, after joining backslash-newline
 * continuations. A lone & splits only before a space or the end, so 2>&1, &> and & inside URLs stay whole.
 * Good enough for policy checks; it is not a shell parser.
 */
function segments(command: string): string[] {
  return command
    .replace(/\\\r?\n/g, '')
    .split(/&&|\|\||;|\||\n|(?<![>&])&(?=\s|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Prefixes that run the command after them, each with its flags: subshells and substitutions, shell keywords,
 * assignments, and wrappers such as sudo, env, timeout, xargs, mise exec and bash -c '...'. A flag value never
 * starts with -, which also keeps these regexes from backtracking on input like "sudo -u -u -u ...".
 */
const PREFIXES = [
  /^(?:\(|\{\s|\$\(|`)\s*/,
  /^(?:if|elif|then|else|do|while|until|export|local|!)\s+/,
  /^\w+=["']?(?=\$\(|`)/,
  /^\w+=(?:"[^"]*"|'[^']*'|[^\s"'])*\s+/,
  /^sudo(?:\s+-[ugUCDhprtT]\s+[^\s-]\S*|\s+-\S+)*\s+/,
  /^env(?:\s+-[uC]\s+[^\s-]\S*|\s+-\S+)*\s+/,
  /^(?:nohup|time|command|exec)(?:\s+-\S+)*\s+/,
  /^timeout(?:\s+-[sk]\s+[^\s-]\S*|\s+-\S+)*\s+\S+\s+/,
  /^nice(?:\s+-n\s+[^\s-]\S*|\s+-\S+)*\s+/,
  /^xargs(?:\s+-[nIPLsdaE]\s+[^\s-]\S*|\s+-\S+)*\s+/,
  /^mise\s+(?:exec|x)\b.*?\s--\s+/,
  /^(?:\S*\/)?(?:ba|z|da)?sh\s+(?:-[-\w]+\s+)*?-\w*c\w*\s+['"]?/,
  /^eval\s+['"]?/,
];

/** go run of the charlie main package, e.g. go run ./cmd/charlie or go run .../cli/cmd/charlie@latest. */
const GO_RUN_CHARLIE = /^go\s+run(?:\s+-(?:C|tags)\s+[^\s-]\S*|\s+-\S+)*\s+(?:\S*\/)?charlie\/?(?:@\S*)?(?=\s|$)/;

/** The command a segment runs once the prefixes above are removed; go run of charlie reads as charlie. */
function commandOf(seg: string): string {
  let cmd = seg;
  let prefix: RegExp | undefined;
  while ((prefix = PREFIXES.find((re) => re.test(cmd)))) cmd = cmd.replace(prefix, '');
  return cmd.replace(GO_RUN_CHARLIE, 'charlie');
}

/** True when a request text explicitly asks for a merge. */
export function asksForMerge(text: string | null | undefined): boolean {
  return !!text && /머지|merge/i.test(text);
}

/**
 * True when a request text asks to delete `target`: it has a deletion word and names the target as a whole name,
 * case-insensitively. A name inside a longer one does not count (moimroom in moimroom--dev).
 */
export function asksToDelete(text: string, target: string): boolean {
  const name = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /삭제|지워|지우|제거|없애|delete|remove/i.test(text) && new RegExp(`(^|[^\\w/-])${name}($|[^\\w/-])`, 'i').test(text);
}

/**
 * The words after a charlie (HopCharlie CLI) binary, or undefined when the command is not charlie. Quoted words
 * stay whole ("switch failed"); quotes and the ) } ` that segmenting leaves behind are dropped.
 */
function charlieArgs(cmd: string): string[] | undefined {
  const m = /^['"\\]?(?:\S*\/)?charlie['"]?(?:\s+(.*))?$/.exec(cmd);
  if (!m) return undefined;
  return (m[1]?.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? []).map((w) => w.replace(/^["']+|["'`)}]+$/g, '')).filter(Boolean);
}

/** True when `words` has `group` and, anywhere after it, one of `subs`; flag values may sit in between. */
function runs(words: string[], group: string, subs: string[]): boolean {
  const at = words.indexOf(group);
  return at >= 0 && words.slice(at + 1).some((w) => subs.includes(w));
}

/** True when the bool flag --name is given and not set to false. */
function flagOn(args: string[], name: string): boolean {
  return args.some((w) => (w === `--${name}` || w.startsWith(`--${name}=`)) && !/=(false|f|0)$/i.test(w));
}

/**
 * charlie policy. A person approves plans and switches; the AI never does. Scheduled runs only read.
 * Deleting an app or an instance needs a request that asks for it by name.
 */
function checkCharlie(args: string[], ctx: BashContext): Verdict | undefined {
  // Subcommand words and arguments: no flags, and not the value of --server (charlie plan --server X approve).
  const words = args.filter((w, i) => !w.startsWith('-') && args[i - 1] !== '--server');
  // --help (or -h) prints help and runs nothing, unless it is the value of the flag before it (--comment --help).
  const opts = args.includes('--') ? args.slice(0, args.indexOf('--')) : args;
  const help = opts.some((w, i) => (w === '--help' || w === '-h') && !/^-[^=]*$/.test(opts[i - 1] ?? ''));
  if (help || words[0] === 'help') return undefined;

  if (runs(words, 'plan', ['approve', 'reject']) || runs(words, 'migrate', ['switch'])) {
    return deny('Plan 승인, 거절과 전환 승인은 사람이 콘솔이나 자기 CLI로 한다. AI는 승인하지 않는다.');
  }
  if (runs(words, 'migrate', ['rollback'])) {
    return deny(
      'migrate rollback은 되돌리는 Plan을 이 토큰 주인이 승인한 것으로 저장하고, 기본으로 전환까지 한다. 되돌릴 run과 명령을 정리해 사람에게 넘긴다.',
    );
  }
  if (flagOn(args, 'auto-switch') || flagOn(args, 'auto-rollback')) {
    return deny(
      '--auto-switch는 사람의 전환 승인을 건너뛰고, --auto-rollback은 게이트를 어기면 플랫폼이 바로 되돌려 전환까지 한다. 둘 다 쓰지 않는다. 전환은 사람이 승인한다.',
    );
  }

  if (ctx.scheduled) {
    if (words.includes('login') || words.includes('logout')) {
      return deny('예약 실행에서는 charlie 로그인과 로그아웃을 하지 않는다. 로그인은 사람이 승인해야 하므로 Slack 요청에서 한다.');
    }
    const deploys = words.includes('deploy') && !['list', 'show', 'watch', 'logs'].includes(words[words.indexOf('deploy') + 1] ?? '');
    if (
      deploys ||
      runs(words, 'app', ['add', 'rm']) ||
      (runs(words, 'app', ['validate']) && flagOn(args, 'remote')) ||
      runs(words, 'plan', ['new', 'submit', 'attach']) ||
      runs(words, 'migrate', ['start', 'abort', 'resume'])
    ) {
      return deny('예약 실행에서는 charlie로 조회만 한다. 이 명령은 플랫폼에 GET이 아닌 요청을 보내므로 실행하지 않는다.');
    }
  }

  // app rm NAME deletes NAME; app branch rm APP X deletes the instance X.
  if (runs(words, 'app', ['rm'])) {
    const rm = words.indexOf('rm', words.indexOf('app'));
    const target = runs(words, 'branch', ['rm']) ? words[rm + 2] : words[rm + 1];
    if (!target || !asksToDelete(ctx.request, target)) {
      return deny(
        `앱과 인스턴스 삭제는 데이터까지 지운다. 이번 요청 글에 삭제를 요청하는 말과 지울 대상의 이름(${target ?? '없음'})이 함께 있을 때만 지운다. 요청자에게 대상 이름을 넣어 다시 요청해 달라고 한다.`,
      );
    }
  }
  return undefined;
}

/**
 * Policy for the Bash tool. Each simple command is checked after removing wrappers such as sudo, timeout or
 * bash -c (see PREFIXES); this is a best-effort policy, not a shell parser.
 * - git push only to an explicit rin/ branch, never forced
 * - gh pr merge only when the requester asked for a merge
 * - no repo deletion, no DELETE through gh api
 * - no kubectl, terraform, helm
 * - charlie: see checkCharlie
 */
export function checkBash(command: string, ctx: BashContext): Verdict {
  for (const seg of segments(command)) {
    const words = commandOf(seg);

    if (/^(kubectl|terraform|tofu|helm)\b/.test(words)) {
      return deny(`${words.split(/\s/)[0]}는 Rin이 실행하지 않는다. 클러스터와 인프라 변경은 사람이 한다.`);
    }

    if (/^git(\s+-C\s+\S+|\s+-c\s+\S+)*\s+push\b/.test(words)) {
      if (/\s(--force|--force-with-lease|-f)(\s|=|$)/.test(words) || /\s\+\S/.test(words)) {
        return deny('force push는 허용하지 않는다.');
      }
      const refs = words.replace(/^git(\s+-C\s+\S+|\s+-c\s+\S+)*\s+push\b/, '').split(/\s+/).filter((w) => w && !w.startsWith('-'));
      // refs[0] is the remote; the rest are refspecs. Every refspec must target a rin/ branch.
      const refspecs = refs.slice(1);
      if (refspecs.length === 0) return deny('git push에는 rin/으로 시작하는 브랜치를 명시해야 한다. 예: git push origin rin/fix-typo');
      for (const spec of refspecs) {
        const target = spec.includes(':') ? spec.split(':').pop()! : spec;
        const branch = target.replace(/^refs\/heads\//, '');
        if (!branch.startsWith('rin/')) return deny(`${branch} 브랜치로는 push할 수 없다. rin/으로 시작하는 브랜치만 push한다.`);
      }
    }

    if (/^gh\s+pr\s+merge\b/.test(words) || (/^gh\s+api\b/.test(words) && /\/merge\b/.test(words))) {
      if (!ctx.mergeAllowed) return deny('요청자가 머지를 명시적으로 요청하지 않았다. PR까지만 열고 머지는 요청을 기다린다.');
    }

    const charlie = charlieArgs(words);
    const verdict = charlie && checkCharlie(charlie, ctx);
    if (verdict) return verdict;

    if (/^gh\s+repo\s+delete\b/.test(words)) return deny('레포 삭제는 허용하지 않는다.');
    if (/^gh\s+api\b/.test(words) && /(-X|--method)\s*=?\s*DELETE\b/i.test(words)) {
      return deny('gh api의 DELETE 요청은 허용하지 않는다.');
    }
  }
  return ALLOW;
}

/** Policy for file-writing tools: the shared clones under repos/ are not edited in place; changes go in a worktree. */
export function checkWritePath(filePath: string | undefined, workspaceDir: string): Verdict {
  if (!filePath) return ALLOW;
  const reposDir = path.resolve(workspaceDir, 'repos');
  const target = path.resolve(workspaceDir, filePath);
  const rel = path.relative(reposDir, target);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    return deny('repos/ 아래 clone은 모든 실행이 같이 쓰는 기준 clone이라 직접 고치지 않는다. worktrees/ 아래에 worktree를 만들고 그 안에서 고친다.');
  }
  return ALLOW;
}
