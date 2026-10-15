import { PageHeader, Empty } from '../components/ui.jsx';

// Explicit placeholder so an un-ported section still resolves to a real route
// instead of a blank page. Replace these one screen at a time.
export default function ComingSoon({ title }) {
    return (
        <>
            <PageHeader title={title} sub="This screen is being ported to the React dashboard." />
            <Empty
                title={'“' + title + '” isn’t migrated yet'}
                hint="The API it needs is unchanged — this is UI work only. Use the classic dashboard in the meantime."
            />
        </>
    );
}
