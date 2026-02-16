import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: 'WoW Auction Optimizer -- Hot Items Radar',
    description:
        'Find high-demand, high-price items across all WoW realms. Powered by real-time auction data analysis.',
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
