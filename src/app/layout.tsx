import ClientRuntime from '@/components/ClientRuntime'
import { META_DATA } from '@/config/constants'
import type { Metadata } from 'next'
import localFont from 'next/font/local'

import '@/assets/scss/app.scss'

// Self-hosted variable fonts (SIL OFL, see src/assets/fonts/LICENSE-*.txt): no network needed at build or runtime.
// The browser picks per glyph via the font stack (see $font-family-sans-serif in _tokens.scss); fallbacks keep the app readable.
const nunito = localFont({
  src: [
    { path: '../assets/fonts/nunito-latin-wght-normal.woff2', weight: '200 1000', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-nunito',
  fallback: ['system-ui', 'sans-serif'],
})
const notoBengali = localFont({
  src: [{ path: '../assets/fonts/noto-sans-bengali-bengali-wght-normal.woff2', weight: '100 900', style: 'normal' }],
  display: 'swap',
  variable: '--font-bengali',
  fallback: ['system-ui', 'sans-serif'],
})

export const metadata: Metadata = {
  title: {
    default: META_DATA.title,
    template: `%s | ${META_DATA.name}`,
  },
  description: META_DATA.description,
  keywords: META_DATA.keywords,
  authors: [{ name: META_DATA.author }],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${nunito.variable} ${notoBengali.variable}`} data-bs-theme="light" dir="ltr">
      <body>
        <ClientRuntime>{children}</ClientRuntime>
      </body>
    </html>
  )
}
