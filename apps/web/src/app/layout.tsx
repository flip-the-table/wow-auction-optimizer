import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: 'Flip the Table — WoW Furniture Flipping Radar',
    description:
        'Furnish your Homestead for gold — flip furniture, stack gold, decorate later. Real-time WoW housing decor auction data.',
    icons: {
        icon: '/favicon.png',
    },
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
