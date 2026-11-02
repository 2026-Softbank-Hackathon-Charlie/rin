import path from 'node:path';

export type Verdict = { allow: true } | { allow: false; reason: string };

const ALLOW: Verdict = { allow: true };
const deny = (reason: string): Verdict => ({ allow: false, reason });

/** Splits a shell line into simple commands at ; && || | and newlines (good enough for policy checks). */
function segments(command: string): string[] {
  return command
    .split(/;|&&|\|\||\||\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when a request text explicitly asks for a merge. */
export function asksForMerge(text: string | null | undefined): boolean {
  return !!text && /머지|merge/i.test(text);
}

/**
 * Policy for the Bash tool.
 * - git push only to an explicit rin/ branch, never forced
 * - gh pr merge only when the requester asked for a merge
 * - no repo deletion, no DELETE through gh api
 * - no kubectl, terraform, helm
 */
export function checkBash(command: string, ctx: { mergeAllowed: boolean }): Verdict {
  for (const seg of segments(command)) {
    const words = seg.replace(/^(sudo|env\s+\S+=\S+)\s+/, '');

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

    if (/^gh\s+repo\s+delete\b/.test(words)) return deny('레포 삭제는 허용하지 않는다.');
    if (/^gh\s+api\b/.test(words) && /(-X|--method)\s*=?\s*DELETE\b/i.test(words)) {
      return deny('gh api의 DELETE 요청은 허용하지 않는다.');
    }
  }
  return ALLOW;
}

/** Policy for file-writing tools: the clones under repos/ are read-only. */
export function checkWritePath(filePath: string | undefined, workspaceDir: string): Verdict {
  if (!filePath) return ALLOW;
  const reposDir = path.resolve(workspaceDir, 'repos');
  const target = path.resolve(workspaceDir, filePath);
  const rel = path.relative(reposDir, target);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    return deny('repos/ 아래 clone은 읽기용이다. 고치려면 worktree를 만들고 그 안에서 고친다.');
  }
  return ALLOW;
}
