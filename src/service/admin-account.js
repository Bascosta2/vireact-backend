const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_ADMIN_PASSWORD_LENGTH = 12;

/** Returns a list of problems with operator-supplied admin details; empty when valid. */
export function validateAdminInput({ email, password, confirm }) {
    const problems = [];
    if (!email || !EMAIL_PATTERN.test(email)) problems.push('a valid --email is required');
    if (!password || password.length < MIN_ADMIN_PASSWORD_LENGTH) {
        problems.push(`password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`);
    }
    if (password !== confirm) problems.push('passwords do not match');
    return problems;
}

/** Value of `--flag value` or `--flag=value` in argv, or undefined. */
export function argValue(argv, flag) {
    const inline = argv.find((a) => a.startsWith(`${flag}=`));
    if (inline) return inline.slice(flag.length + 1);
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}
