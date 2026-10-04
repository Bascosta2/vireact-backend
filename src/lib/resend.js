import { Resend } from 'resend';
import { RESEND_API_KEY, NODE_ENV, EMAIL_DEV_OVERRIDE_TO } from '../config/index.js';


const resend = new Resend(RESEND_API_KEY);

// Outside production, EMAIL_DEV_OVERRIDE_TO reroutes every email so local runs never reach real users.
if (NODE_ENV !== 'production' && EMAIL_DEV_OVERRIDE_TO) {
    const send = resend.emails.send.bind(resend.emails);
    resend.emails.send = ({ to, cc, bcc, subject, ...rest }, options) => {
        const original = [to, cc, bcc].flat().filter(Boolean).join(', ');
        return send(
            { ...rest, to: EMAIL_DEV_OVERRIDE_TO, subject: `[DEV → ${original}] ${subject ?? ''}` },
            options
        );
    };
}

export default resend;
