import { useState } from 'react';
import { api } from '../api.js';
import { useServers, useTextChannels } from '../lib.js';
import { Card, Grid, PageHeader, ServerSelect, Empty, Button, Input, Textarea, ChannelSelect } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

export default function Polls() {
    const { data: servers } = useServers();
    const toast = useToast();
    const [guildId, setGuildId] = useState('');
    const { data: channels } = useTextChannels(guildId);

    // Poll form
    const [question, setQuestion] = useState('');
    const [options, setOptions] = useState(['', '', '', '']);
    const [type, setType] = useState('single');
    const [hours, setHours] = useState(24);
    const [pollChannel, setPollChannel] = useState('');

    // Announcement form
    const [title, setTitle] = useState('');
    const [message, setMessage] = useState('');
    const [color, setColor] = useState('#5865f2');
    const [annChannel, setAnnChannel] = useState('');

    function setOption(i, value) {
        setOptions((prev) => prev.map((o, idx) => (idx === i ? value : o)));
    }

    async function createPoll() {
        const filled = options.map((o) => o.trim()).filter(Boolean);
        if (!guildId || !pollChannel || !question.trim() || filled.length < 2) {
            toast('Question, two options and a channel are required', true);
            return;
        }
        try {
            await api.post('/api/polls/create', {
                guildId, channelId: pollChannel, question: question.trim(), options: filled,
                multi: type === 'multi', anonymous: type === 'anonymous', durationHours: Number(hours) || 24,
            });
            toast('Poll created');
            setQuestion(''); setOptions(['', '', '', '']);
        } catch (err) {
            toast(err.message || 'Could not create poll', true);
        }
    }

    async function createAnnouncement() {
        if (!guildId || !annChannel || !title.trim() || !message.trim()) {
            toast('Title, message and a channel are required', true);
            return;
        }
        try {
            await api.post('/api/announcements/create', {
                guildId, channelId: annChannel, title: title.trim(), message: message.trim(), color,
            });
            toast('Announcement sent');
            setTitle(''); setMessage('');
        } catch (err) {
            toast(err.message || 'Could not send announcement', true);
        }
    }

    return (
        <>
            <PageHeader title="Polls & Announcements" sub="Post polls and announcements into a channel" />

            <div className="toolbar">
                <ServerSelect servers={servers} value={guildId}
                    onChange={(id) => { setGuildId(id); setPollChannel(''); setAnnChannel(''); }} />
            </div>

            {!guildId
                ? <Empty title="Select a server" hint="Polls and announcements post into one server at a time." />
                : (
                    <Grid cols={2}>
                        <Card title="Create Poll" icon="chart">
                            <div className="field-block">
                                <label>Question</label>
                                <Input placeholder="Poll question" value={question} onChange={(e) => setQuestion(e.target.value)} />
                            </div>
                            {[0, 1, 2, 3].map((i) => (
                                <div className="field-block" key={i}>
                                    <label>Option {i + 1}{i > 1 ? ' (optional)' : ''}</label>
                                    <Input value={options[i]} onChange={(e) => setOption(i, e.target.value)} />
                                </div>
                            ))}
                            <div className="form-row mt">
                                <label className="inline-label">Type</label>
                                <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
                                    <option value="single">Single vote</option>
                                    <option value="multi">Multi vote</option>
                                    <option value="anonymous">Anonymous</option>
                                </select>
                                <Input type="number" min="0.25" max="720" step="0.25" value={hours}
                                    onChange={(e) => setHours(e.target.value)} style={{ maxWidth: 130 }} title="Duration (hours)" />
                            </div>
                            <div className="form-row mt">
                                <ChannelSelect channels={channels} value={pollChannel} onChange={setPollChannel} />
                                <Button onClick={createPoll}>Create poll</Button>
                            </div>
                        </Card>

                        <Card title="Create Announcement" icon="pulse">
                            <div className="field-block">
                                <label>Title</label>
                                <Input placeholder="Announcement title" value={title} onChange={(e) => setTitle(e.target.value)} />
                            </div>
                            <div className="field-block">
                                <label>Message</label>
                                <Textarea rows={5} placeholder="Announcement body" value={message} onChange={(e) => setMessage(e.target.value)} />
                            </div>
                            <div className="field-block">
                                <label>Colour</label>
                                <input type="color" className="color-input" value={color} onChange={(e) => setColor(e.target.value)} />
                            </div>
                            <div className="form-row mt">
                                <ChannelSelect channels={channels} value={annChannel} onChange={setAnnChannel} />
                                <Button onClick={createAnnouncement}>Send announcement</Button>
                            </div>
                        </Card>
                    </Grid>
                )}
        </>
    );
}
