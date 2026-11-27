import { redirect } from 'next/navigation'

/** `/` is just the dashboard; the (admin) layout handles install + session checks. */
export default function Home() {
  redirect('/dashboard')
}
