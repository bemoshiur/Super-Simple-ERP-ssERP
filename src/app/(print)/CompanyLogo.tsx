/** Company logo for printed documents. `src` comes from getCompanyProfile, which only returns https:// or same-origin paths. */
const CompanyLogo = ({ src, name, height = 48 }: { src: string | null; name: string; height?: number }) =>
  src ? (
    // eslint-disable-next-line @next/next/no-img-element -- validated URL; plain img prints reliably and needs no remote-image config
    <img src={src} alt={`${name} logo`} referrerPolicy="no-referrer" style={{ maxHeight: height, maxWidth: 200, display: 'block', marginBottom: 4 }} />
  ) : null

export default CompanyLogo
