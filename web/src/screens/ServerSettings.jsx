import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, Input } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

// Per-server Settings, ported from vanilla's hub pane
// (src/dashboard/parts/02-ui-shell.mjs — loadSrvSettings / saveSrvSettings).
// It held two things and nothing else:
//
//   Command Prefix   d.prefix     → POST {prefix}     (default ';', max 5 chars, no spaces)
//   Embed Color      d.embedColor → POST {embedColor} ('#rrggbb', or '' for the bot default)
//
// Both are read from GET /api/server/:id and written through
// POST /api/server/:id/settings, which answers {success:true} or a 400/403/404
// with {error}. Neither save nor load is a request of this pane's own: the
// server-detail route has already fetched that payload, so the form is seeded
// from it and cannot disagree with the header about which server it describes.
//
// The endpoint validates both fields but applies them one at a time - a bad
// prefix returns before anything is written, yet a valid prefix is written
// before a bad colour is rejected. The prefix is therefore checked here first,
// with the endpoint's own rule and message, so a rejected save cannot leave
// half of the form persisted. The colour needs no client-side check: it can only
// come from a colour input, which yields '#rrggbb' or nothing at all, and the
// payload's own value is already that form.

const DEFAULT_COLOR = '#5865F2';

// `useDefault` mirrors "this server has no custom colour", which is what the
// API's null means. Vanilla left the checkbox unchecked in that state, so the
// control described nothing and saving the prefix alone silently pinned the
// bot default as an explicit per-server value.
function seed(prefix, embedColor) {
    return {
        prefix: prefix || ';',
        embedColor: embedColor || DEFAULT_COLOR,
        useDefault: !embedColor,
    };
}

export default function ServerSettings({ serverId, prefix, embedColor, onSaved }) {
    const toast = useToast();
    const [form, setForm] = useState(() => seed(prefix, embedColor));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    // Re-seed when the pane is re-pointed at another server, and when the loaded
    // payload changes underneath it — a save followed by a detail reload is
    // exactly that, so the form ends up showing what actually persisted rather
    // than what was typed.
    useEffect(() => {
        setForm(seed(prefix, embedColor));
        setError(null);
    }, [serverId, prefix, embedColor]);

    function set(field, value) {
        setForm((prev) => ({ ...prev, [field]: value }));
    }

    async function save() {
        const forId = serverId;
        const next = form.prefix.trim();
        if (next.length > 5 || /\s/.test(next)) {
            setError('Prefix must be 1-5 characters with no spaces');
            return;
        }
        const color = form.useDefault ? '' : form.embedColor;

        setBusy(true);
        setError(null);
        try {
            // Both fields go together, as vanilla sent them; the API treats an
            // absent key as "leave this one alone", so sending both is what makes
            // the form and the stored config agree afterwards.
            await api.post('/api/server/' + forId + '/settings', { prefix: next, embedColor: color });
            toast('Server settings saved');
            // The id goes with the notification: the reply can land after the
            // view has moved to another server, and it is the view that knows
            // whether this save still belongs to what it is showing.
            if (onSaved) onSaved(forId);
        } catch (err) {
            setError(err.message || 'Could not save server settings');
        } finally {
            setBusy(false);
        }
    }

    return (
        <Card title="Server Settings" icon="sliders"
            action={<Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>}>
            <div className="field">
                <label htmlFor="srv-prefix">Command Prefix</label>
                <Input id="srv-prefix" value={form.prefix} maxLength={5}
                    onChange={(e) => set('prefix', e.target.value)} />
            </div>
            <p className="hint">Prefix for text commands (default: ;). Max 5 characters, no spaces.</p>

            <div className="field">
                <label htmlFor="srv-embed-color">Embed Color</label>
                <input id="srv-embed-color" type="color" className="color-input" value={form.embedColor}
                    onChange={(e) => setForm((prev) => ({ ...prev, embedColor: e.target.value, useDefault: false }))} />
                <span className="mono">{form.useDefault ? 'Bot default' : form.embedColor}</span>
                <label className="inline-label">
                    <input type="checkbox" checked={form.useDefault}
                        onChange={(e) => set('useDefault', e.target.checked)} /> Use bot default
                </label>
            </div>
            <p className="hint">
                Accent color for this server’s embeds (welcome messages, giveaways, and other
                embeds that read guild config).
            </p>

            {error && <p className="result result-bad" role="alert">{error}</p>}
        </Card>
    );
}
