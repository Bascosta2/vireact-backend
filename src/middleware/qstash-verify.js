import { Receiver } from '@upstash/qstash';

/**
 * Verifies QStash signature on the raw body, then parses JSON into req.body.
 * Must run after express.raw() for POST /api/v1/videos/analyze.
 */
export function verifyQStashAndParseBody(req, res, next) {
    const run = async () => {
        try {
            console.log('[QStash Verify] Middleware triggered');
            console.log('[QStash Verify] NODE_ENV:', process.env.NODE_ENV);

            const signature = req.headers['upstash-signature'];
            if (!signature) {
                console.error('[QStash Verify] Missing upstash-signature header');
                return res.status(401).json({ error: 'Missing signature' });
            }

            const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY || '';
            const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY || '';

            if (!currentSigningKey && !nextSigningKey) {
                console.warn('[QStash Verify] No signing keys; skipping signature verification');
            } else {
                const receiver = new Receiver({
                    currentSigningKey,
                    nextSigningKey,
                });

                const rawBodyStr = Buffer.isBuffer(req.body)
                    ? req.body.toString('utf8')
                    : typeof req.body === 'string'
                      ? req.body
                      : JSON.stringify(req.body ?? {});

                const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

                try {
                    const isValid = await receiver.verify({
                        signature,
                        body: rawBodyStr,
                        url,
                    });

                    if (!isValid) {
                        console.error('[QStash Verify] Signature verification FAILED');
                        return res.status(401).json({ error: 'Invalid signature' });
                    }
                } catch (verifyErr) {
                    console.error(
                        '[QStash Verify] Signature verification error:',
                        verifyErr?.message || verifyErr
                    );
                    return res.status(401).json({ error: 'Invalid signature' });
                }

                console.log('[QStash Verify] Signature verified successfully');
            }

            const rawForParse = Buffer.isBuffer(req.body)
                ? req.body.toString('utf8')
                : typeof req.body === 'string'
                  ? req.body
                  : JSON.stringify(req.body ?? '');

            try {
                req.body = JSON.parse(rawForParse || '{}');
                console.log('[QStash Verify] Body parsed successfully:', JSON.stringify(req.body));
            } catch (parseError) {
                console.error('[QStash Verify] Body parse error:', parseError.message);
                console.error('[QStash Verify] Raw body was:', req.body);
                return res.status(400).json({ error: 'Invalid JSON body' });
            }

            next();
        } catch (error) {
            console.error('[QStash Verify] Unexpected error:', error.message);
            return res.status(500).json({ error: 'Verification error' });
        }
    };

    run().catch(next);
}
