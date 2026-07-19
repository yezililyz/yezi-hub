import { Link } from 'react-router-dom'

interface Crumb {
  label: string
  to?: string
}

export default function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 12.5, fontFamily: 'var(--mono), monospace' }}>
      {items.map((item, i) => {
        const isLast = i === items.length - 1
        return (
          <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {item.to && !isLast ? (
              <Link to={item.to} style={{ color: 'var(--ink-soft)', textDecoration: 'none' }}>{item.label}</Link>
            ) : (
              <span style={{ color: isLast ? 'var(--orange-deep)' : 'var(--ink-soft)', fontWeight: isLast ? 700 : 400 }}>{item.label}</span>
            )}
            {!isLast && <span style={{ color: 'var(--faint)' }}>/</span>}
          </span>
        )
      })}
    </nav>
  )
}
