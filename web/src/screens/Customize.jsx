import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAsync } from '../lib.js';
import { applyConfig, PALETTES } from '../config.js';
import { Card, PageHeader, Skeleton, Empty, Button, Input, Select } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

// Same presets the vanilla Customize section offered.
const ACCENTS = [
    { name: 'Purple', color: '#5865F2' }, { name: 'Blue', color: '#3b82f6' }, { name: 'Green', color: '#10b981' },
    { name: 'Cyan', color: '#06b6d4' }, { name: 'Pink', color: '#ec4899' }, { name: 'Orange', color: '#f97316' },
    { name: 'Red', color: '#ef4444' }, { name: 'White', color: '#e8e8ee' }, { name: 'Amber', color: '#f59e0b' },
    { name: 'Lime', color: '#84cc16' }, { name: 'Teal', color: '#14b8a6' }, { name: 'Rose', color: '#f43f5e' },
];

const FONTS = [
    { value: 'inter', label: 'Inter (default)' },
    { value: 'system', label: 'System UI' },
    { value: 'grotesk', label: 'Space Grotesk' },
    { value: 'rounded', label: 'Nunito (Rounded)' },
    { value: 'mono', label: 'JetBrains Mono' },
];

function ToggleRow({ label, sub, checked, onChange }) {
    return (
        <div className="field">
            <div>
                <label>{label}</label>
                {sub && <div className="hint" style={{ margin: 0 }}>{sub}</div>}
            </div>
            <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
        </div>
    );
}

export default function Customize() {
    const toast = useToast();
    const { data, loading, error, reload } = useAsync(() => api.get('/api/dash/config'), []);

    const [form, setForm] = useState(null);

    // Seed the form from the config once it arrives (and after each reload).
    useEffect(() => {
        if (data) setForm(data);
    }, [data]);

    const header = <PageHeader title="Customize" sub="Make the dashboard yours." onRefresh={reload} refreshing={loading} />;

    if (loading && !data) return <>{header}<Skeleton rows={6} /></>;
    if (error || !data) {
        return (
            <>
                {header}
                <Empty title="Could not load customization settings" hint={(error && error.message) || 'Owner access is required.'} />
            </>
        );
    }
    if (!form) return null;

    const c = form;
    function set(key, value) {
        setForm((prev) => ({ ...prev, [key]: value }));
    }

    // Live preview: re-apply the whole config with the edited value. The
    // applier is idempotent and cheap, and this covers every visual field
    // (accent, font, radius, borders, card style, density, palette, bg).
    function preview(next) {
        setForm((prev) => {
            applyConfig({ ...prev, ...next });
            return { ...prev, ...next };
        });
    }

    async function save() {
        try {
            const res = await api.post('/api/dash/config', {
                accentColor: c.accentColor,
                title: c.title || 'Dashboard',
                backgroundImage: c.backgroundImage || null,
                backgroundType: c.backgroundType || 'none',
                backgroundBlur: c.backgroundBlur || 'md',
                backgroundStyle: c.backgroundStyle || 'none',
                cardStyle: c.cardStyle || 'glass',
                layoutDensity: c.layoutDensity || 'normal',
                refreshInterval: parseInt(c.refreshInterval) || 5,
                showWidgets: c.showWidgets || {},
                animationPreset: c.animationPreset || 'smooth',
                animationSpeed: parseFloat(c.animationSpeed) || 1,
                cardGlow: !!c.cardGlow,
                ambientLight: !!c.ambientLight,
                headerStyle: c.headerStyle || 'minimal',
                borderRadius: c.borderRadius || 'rounded',
                borderStrength: c.borderStrength || 'normal',
                themePreset: c.themePreset || 'discord',
                fontFamily: c.fontFamily || 'system',
                botAvatarUrl: c.botAvatarUrl || null,
                logoUrl: c.logoUrl || null,
                faviconUrl: c.faviconUrl || null,
            });
            if (res.config) {
                setForm(res.config);
                applyConfig(res.config);
            }
            toast('Settings saved');
        } catch (err) {
            toast(err.message || 'Failed to save', true);
        }
    }

    async function upload(file, target) {
        if (!file) return;
        const fd = new FormData();
        fd.append('background', file);
        try {
            const res = await fetch('/api/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
            const d = await res.json();
            if (d.success) {
                preview({ [target]: d.url });
                toast('Uploaded — press Save to keep it');
            } else {
                toast(d.error || 'Upload failed', true);
            }
        } catch {
            toast('Upload failed', true);
        }
    }

    return (
        <>
            {header}

            <div className="grid grid-2">
                <Card title="Appearance" icon="sliders">
                    <div className="field-block">
                        <label>Accent colour</label>
                        <div className="form-row">
                            <input type="color" className="color-input" value={c.accentColor || '#5865F2'}
                                onChange={(e) => preview({ accentColor: e.target.value })} />
                            <span className="mono">{c.accentColor}</span>
                        </div>
                        <div className="chips mt">
                            {ACCENTS.map((a) => (
                                <button key={a.color} type="button"
                                    className={'chip chip-btn' + (c.accentColor === a.color ? ' chip-on' : '')}
                                    style={{ borderLeft: '4px solid ' + a.color }}
                                    onClick={() => preview({ accentColor: a.color })}>
                                    {a.name}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="field-block">
                        <label>Dashboard title</label>
                        <Input value={c.title || ''} onChange={(e) => preview({ title: e.target.value })} placeholder="Vigil" />
                    </div>

                    <div className="field-block">
                        <label>Colour palette</label>
                        <div className="chips">
                            {PALETTES.map((p) => (
                                <button key={p.id} type="button"
                                    className={'chip chip-btn' + ((c.themePreset || 'discord') === p.id ? ' chip-on' : '')}
                                    style={{ borderLeft: '4px solid transparent', backgroundImage: p.swatch }}
                                    onClick={() => preview({ themePreset: p.id })}>
                                    <span style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)', color: '#fff' }}>{p.name}</span>
                                </button>
                            ))}
                        </div>
                        <p className="hint">Full interface colour schemes (backgrounds, surfaces, borders). Applies to dark mode; light mode keeps standard surfaces.</p>
                    </div>

                    <div className="field-block">
                        <label>Interface font</label>
                        <Select value={c.fontFamily || 'inter'} onChange={(e) => preview({ fontFamily: e.target.value })}>
                            {FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                        </Select>
                    </div>

                    <div className="field-block">
                        <label>Corner radius</label>
                        <Select value={c.borderRadius || 'rounded'} onChange={(e) => preview({ borderRadius: e.target.value })}>
                            <option value="compact">Compact</option>
                            <option value="rounded">Rounded</option>
                            <option value="pill">Pill</option>
                        </Select>
                    </div>

                    <div className="field-block">
                        <label>Border intensity</label>
                        <Select value={c.borderStrength || 'normal'} onChange={(e) => preview({ borderStrength: e.target.value })}>
                            <option value="subtle">Subtle</option>
                            <option value="normal">Normal</option>
                            <option value="strong">Strong</option>
                        </Select>
                    </div>

                    <div className="field-block">
                        <label>Card style</label>
                        <Select value={c.cardStyle || 'glass'} onChange={(e) => preview({ cardStyle: e.target.value })}>
                            <option value="glass">Glass</option>
                            <option value="solid">Solid</option>
                            <option value="border">Border only</option>
                        </Select>
                    </div>

                    <div className="field-block">
                        <label>Layout density</label>
                        <Select value={c.layoutDensity || 'normal'} onChange={(e) => preview({ layoutDensity: e.target.value })}>
                            <option value="compact">Compact</option>
                            <option value="normal">Normal</option>
                            <option value="comfortable">Comfortable</option>
                        </Select>
                    </div>

                    <ToggleRow label="Card glow" sub="Mouse-tracking card border glow" checked={c.cardGlow} onChange={(v) => set('cardGlow', v)} />
                    <ToggleRow label="Ambient light" sub="Mouse-following radial light" checked={c.ambientLight} onChange={(v) => set('ambientLight', v)} />
                </Card>

                <div>
                    <Card title="Background" icon="moon">
                        <div className="field-block">
                            <label>Background image</label>
                            <Select value={c.backgroundType || 'none'} onChange={(e) => preview({ backgroundType: e.target.value })}>
                                <option value="none">Disabled</option>
                                <option value="url">From URL</option>
                                <option value="upload">Upload</option>
                            </Select>
                        </div>
                        {c.backgroundType === 'url' && (
                            <div className="field-block">
                                <label>Image URL</label>
                                <Input value={c.backgroundImage || ''}
                                    onChange={(e) => preview({ backgroundImage: e.target.value })}
                                    placeholder="https://…jpg" />
                            </div>
                        )}
                        {c.backgroundType === 'upload' && (
                            <div className="field-block">
                                <label>Upload image</label>
                                <input type="file" accept="image/*" className="input"
                                    onChange={(e) => upload(e.target.files && e.target.files[0], 'backgroundImage')} />
                            </div>
                        )}
                        <div className="field-block">
                            <label>Background blur</label>
                            <Select value={c.backgroundBlur || 'md'} onChange={(e) => set('backgroundBlur', e.target.value)}>
                                <option value="0">None</option>
                                <option value="sm">Light</option>
                                <option value="md">Medium</option>
                                <option value="lg">Heavy</option>
                            </Select>
                        </div>
                        <div className="field-block">
                            <label>Background effect</label>
                            <Select value={c.backgroundStyle || 'none'} onChange={(e) => set('backgroundStyle', e.target.value)}>
                                <option value="none">None</option>
                                <option value="dots">Dots</option>
                                <option value="shapes">Shapes</option>
                                <option value="glitch">Glitch</option>
                                <option value="liquid">Liquid</option>
                                <option value="grid">Grid</option>
                                <option value="constellation">Constellation</option>
                                <option value="aurora">Aurora</option>
                                <option value="starfield">Starfield</option>
                                <option value="waves">Waves</option>
                            </Select>
                            <p className="hint">Effects render live on the vanilla dashboard; the React app keeps this setting so both UIs agree.</p>
                        </div>
                    </Card>

                    <div className="mt">
                        <Card title="Branding" icon="star">
                            <div className="field-block">
                                <label>Bot avatar URL (display)</label>
                                <Input value={c.botAvatarUrl || ''} onChange={(e) => set('botAvatarUrl', e.target.value)}
                                    placeholder="https://cdn.discordapp.com/…png" />
                            </div>
                            <div className="field-block">
                                <label>Navbar logo</label>
                                <Input value={c.logoUrl || ''} onChange={(e) => preview({ logoUrl: e.target.value })}
                                    placeholder="https://…png or upload below" />
                                <input type="file" accept="image/*" className="input"
                                    onChange={(e) => upload(e.target.files && e.target.files[0], 'logoUrl')} />
                                {c.logoUrl && <Button variant="ghost" onClick={() => preview({ logoUrl: '' })}>Clear logo</Button>}
                            </div>
                            <div className="field-block">
                                <label>Favicon</label>
                                <Input value={c.faviconUrl || ''} onChange={(e) => preview({ faviconUrl: e.target.value })}
                                    placeholder="https://…png or upload below" />
                                <input type="file" accept="image/*" className="input"
                                    onChange={(e) => upload(e.target.files && e.target.files[0], 'faviconUrl')} />
                                {c.faviconUrl && <Button variant="ghost" onClick={() => preview({ faviconUrl: '' })}>Clear favicon</Button>}
                            </div>
                            <p className="hint">Logo and favicon also apply to the login page. Press Save to keep them.</p>
                        </Card>
                    </div>

                    <div className="mt">
                        <Card title="Motion & behaviour" icon="pulse">
                            <div className="field-block">
                                <label>Animation preset</label>
                                <Select value={c.animationPreset || 'smooth'} onChange={(e) => set('animationPreset', e.target.value)}>
                                    <option value="subtle">Subtle</option>
                                    <option value="smooth">Smooth</option>
                                    <option value="energetic">Energetic</option>
                                </Select>
                            </div>
                            <div className="field-block">
                                <label>Animation speed</label>
                                <Select value={String(c.animationSpeed || 1)} onChange={(e) => set('animationSpeed', parseFloat(e.target.value))}>
                                    <option value="0.5">0.5x slow</option>
                                    <option value="0.75">0.75x relaxed</option>
                                    <option value="1">1x normal</option>
                                    <option value="1.25">1.25x fast</option>
                                    <option value="1.5">1.5x turbo</option>
                                </Select>
                            </div>
                            <div className="field-block">
                                <label>Refresh interval</label>
                                <Select value={String(c.refreshInterval || 5)} onChange={(e) => set('refreshInterval', parseInt(e.target.value))}>
                                    <option value="3">3s</option>
                                    <option value="5">5s</option>
                                    <option value="10">10s</option>
                                    <option value="30">30s</option>
                                    <option value="60">60s</option>
                                </Select>
                            </div>
                            <ToggleRow label="Dark mode" sub="Saved with the config; the top-bar toggle overrides locally" checked={c.darkMode}
                                onChange={(v) => {
                                    set('darkMode', v);
                                    document.documentElement.classList.toggle('light-mode', !v);
                                    applyConfig({ ...c, darkMode: v }, v);
                                }} />
                            <ToggleRow label="Show dock labels" checked={c.showDockLabels} onChange={(v) => set('showDockLabels', v)} />
                        </Card>
                    </div>

                    <div className="mt">
                        <Card title="Visible sections" icon="grid">
                            {['status', 'servers', 'reminders', 'quickActions', 'analytics', 'activity', 'system'].map((w) => (
                                <ToggleRow key={w} label={w} checked={(c.showWidgets || {})[w] !== false}
                                    onChange={(v) => set('showWidgets', { ...(c.showWidgets || {}), [w]: v })} />
                            ))}
                            <p className="hint">Controls which overview widgets render.</p>
                        </Card>
                    </div>
                </div>
            </div>

            <div className="mt row-actions">
                <Button onClick={save}>Save all settings</Button>
                <Button variant="ghost" onClick={() => { setForm(data); applyConfig(data); }}>Revert</Button>
            </div>
        </>
    );
}
