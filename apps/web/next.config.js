/** @type {import('next').NextConfig} */
const nextConfig = {
    output: 'standalone',
    images: {
        remotePatterns: [
            {
                protocol: 'https',
                hostname: 'render.worldofwarcraft.com',
            },
            {
                protocol: 'https',
                hostname: '*.blzstatic.cn',
            },
        ],
    },
};

module.exports = nextConfig;
