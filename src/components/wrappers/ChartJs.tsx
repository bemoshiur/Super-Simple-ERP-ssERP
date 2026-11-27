'use client'
import { CategoryScale, Chart as ChartJS, Legend, LinearScale, Tooltip, type ChartComponentLike, type ChartConfiguration, type ChartOptions } from 'chart.js'
import merge from 'lodash/merge'
import { useEffect, useState, type CSSProperties } from 'react'
import { Chart } from 'react-chartjs-2'

export type ChartSpec = { data: ChartConfiguration['data']; options?: ChartConfiguration['options'] }

/**
 * Reads a design token from the stylesheet (e.g. cssToken('--ss-brand')). Optional alpha turns a hex colour into rgba().
 * Returns '' on the server; charts are only drawn after mount.
 */
export function cssToken(name: string, alpha?: number): string {
  if (typeof document === 'undefined') return ''
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (alpha === undefined || !/^#[0-9a-f]{6}$/i.test(value)) return value
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16))
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** House style shared by every chart: app font, muted ticks, light horizontal grid only. */
function baseOptions(): ChartOptions {
  const family = getComputedStyle(document.body).fontFamily
  const muted = cssToken('--ss-text-muted')
  return {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { ticks: { color: muted, font: { family } }, grid: { display: false }, border: { display: false } },
      y: { ticks: { color: muted, font: { family } }, grid: { color: cssToken('--ss-chart-grid') }, border: { display: false } },
    },
    plugins: {
      legend: { labels: { color: muted, font: { family }, usePointStyle: true, boxWidth: 8, boxHeight: 8 } },
      tooltip: { titleFont: { family }, bodyFont: { family }, padding: 10, cornerRadius: 6 },
    },
  }
}

type Props = {
  type: ChartConfiguration['type']
  /** Builds data + options; called after mount (so design tokens can be read). Memoise it with useCallback. */
  getOptions: () => ChartSpec
  /** Chart.js controllers/elements this chart needs beyond scales, tooltip and legend. */
  plugins?: ChartComponentLike
  height?: number | string
  width?: number | string
  style?: CSSProperties
}

const ChartJs = ({ type, getOptions, plugins, height = '100%', width = '100%', style }: Props) => {
  const [config, setConfig] = useState<{ data: ChartConfiguration['data']; options: ChartOptions } | null>(null)

  useEffect(() => {
    ChartJS.register(CategoryScale, LinearScale, Tooltip, Legend, plugins ?? [])
    const { data, options } = getOptions()
    // Reading tokens needs the DOM, so the chart is configured once mounted.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConfig({ data, options: merge({}, baseOptions(), options) })
  }, [getOptions, plugins])

  if (!config) return <div style={{ height, width }} aria-hidden="true" />
  return <Chart type={type} data={config.data} options={config.options} height={height} width={width} style={{ maxHeight: height, ...style }} />
}

export default ChartJs
