import type { Metadata } from 'next';
import { Inter, Fraunces } from 'next/font/google';
import './globals.css';

const inter = Inter({
    subsets: ['latin'],
    weight: ['400', '500', '600', '700', '800'],
    variable: '--font-inter',
    display: 'swap',
});

// Display face: a soft old-style serif with almanac-print character —
// titles and brand only; data stays in Inter for legibility.
const fraunces = Fraunces({
    subsets: ['latin'],
    weight: ['600', '700'],
    variable: '--font-display',
    display: 'swap',
});

export const metadata: Metadata = {
    title: 'Flip the Table — WoW Furniture Flipping Radar',
    description:
        'Furnish your Homestead for gold — flip furniture, stack gold, decorate later. Real-time WoW housing decor auction data.',
    icons: {
        icon: '/favicon.svg',
    },
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en" className={`${inter.variable} ${fraunces.variable}`}>
            <body>{children}</body>
        </html>
    );
}
