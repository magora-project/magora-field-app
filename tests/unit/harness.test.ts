import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('harness', () => {
  test('AGENTS.md has every cloud rule', () => {
    const agents = read('AGENTS.md');
    for (const s of [
      'claude/*',
      'draft',
      'Never push to, merge into, or change settings on `main`',
      'Never add a secret',
      'real Supabase URL',
      'Every task names a test that runs against the local stack',
      'Backend changes are proposed as a portal issue',
      'CLOUD-RULES-MARKER: magora-field-app v1',
    ]) {
      expect(agents).toContain(s);
    }
  });

  test('CLAUDE.md imports AGENTS.md', () => {
    expect(read('CLAUDE.md')).toBe('@AGENTS.md\n');
  });

  test('SessionStart hook runs the session script', () => {
    const settings = JSON.parse(read('.claude/settings.json'));
    const hooks = settings.hooks.SessionStart.flatMap(
      (g: { hooks: { command: string; timeout?: number }[] }) => g.hooks,
    );
    expect(hooks).toContainEqual(
      expect.objectContaining({
        command: 'bash scripts/cloud-session-start.sh',
        timeout: 600,
      }),
    );
  });

  test('all four skills are present', () => {
    for (const name of [
      'brainstorming',
      'writing-plans',
      'subagent-driven-development',
      'test-driven-development',
    ]) {
      const text = read(`.claude/skills/${name}/SKILL.md`);
      const m = text.match(/^---\n([\s\S]*?)\n---\n/);
      expect(m).not.toBeNull();
      expect(m![1]).toMatch(new RegExp(`^name: ${name}$`, 'm'));
    }
    const upstream = read('.claude/skills/UPSTREAM.md');
    expect(upstream).toContain('obra/superpowers');
    expect(upstream).toContain('bb92a77741419a4ab5f06e711a283343f1ada0c3');
  });
});
