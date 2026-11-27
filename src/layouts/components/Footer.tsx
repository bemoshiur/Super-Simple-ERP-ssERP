import { currentYear, META_DATA } from '@/config/constants'

/** Slim page foot inside the content frame. */
export default function Footer() {
  return (
    <footer className="ss-footer">
      <span>
        © {currentYear} {META_DATA.name}
      </span>
      <span>Open-source ERP · MIT licence</span>
    </footer>
  )
}
