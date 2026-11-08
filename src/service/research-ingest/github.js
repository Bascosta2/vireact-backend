/**
 * Read-only access to the research repo through the GitHub contents API.
 * Uses RESEARCH_REPO_TOKEN (fine-grained, Contents: read-only, this repo only). Never logged.
 */
const API = 'https://api.github.com';
const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
const RETIRE_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export const createGithubReader = ({ repo, branch = 'main', token = process.env.RESEARCH_REPO_TOKEN, fetchImpl = globalThis.fetch } = {}) => {
    if (!token) throw new Error('RESEARCH_REPO_TOKEN is not set');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('RESEARCH_REPO must be owner/name');

    const request = async (path, accept = 'application/vnd.github+json') => {
        const url = `${API}/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`;
        const res = await fetchImpl(url, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: accept,
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'vireact-research-ingest',
            },
        });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
        return res;
    };

    const list = async (path) => {
        const res = await request(path);
        if (!res) return [];
        const body = await res.json();
        return Array.isArray(body) ? body : [];
    };

    const readText = async (path) => {
        const res = await request(path, 'application/vnd.github.raw+json');
        if (!res) return '';
        const text = await res.text();
        if (text.length > MAX_FILE_BYTES) throw new Error(`${path} is larger than 2 MB`);
        return text;
    };

    return {
        /** approved/<YYYY-MM-DD> folder names, oldest first. */
        listApprovedBatches: async () =>
            (await list('approved')).filter((e) => e.type === 'dir' && DATE_DIR.test(e.name)).map((e) => e.name).sort(),
        /** [{ path, text }] for every .jsonl file in approved/<batch>/. */
        readBatch: async (batch) => {
            if (!DATE_DIR.test(batch)) throw new Error(`bad batch ${batch}`);
            const files = (await list(`approved/${batch}`)).filter((e) => e.type === 'file' && e.name.endsWith('.jsonl'));
            const out = [];
            for (const f of files) out.push({ path: f.path, text: await readText(f.path) });
            return out;
        },
        /** retire/<YYYY-MM-DD>.jsonl files, oldest first: [{ date, path }]. */
        listRetireFiles: async () =>
            (await list('retire'))
                .filter((e) => e.type === 'file' && RETIRE_FILE.test(e.name))
                .map((e) => ({ date: e.name.match(RETIRE_FILE)[1], path: e.path }))
                .sort((a, b) => a.date.localeCompare(b.date)),
        readText,
    };
};

/** Parse JSONL text: [{ line, value }] or [{ line, error }]. Blank lines are skipped. */
export const parseJsonl = (text) =>
    String(text || '')
        .split(/\r?\n/)
        .map((raw, i) => ({ raw: raw.trim(), line: i + 1 }))
        .filter((l) => l.raw)
        .map(({ raw, line }) => {
            try {
                return { line, value: JSON.parse(raw) };
            } catch (error) {
                return { line, error: `invalid JSON: ${error.message.slice(0, 80)}` };
            }
        });
