import EmptyState from './EmptyState'

/** Shown when the signed-in role lacks the module's view permission (the menu already hides the link). */
const NoAccess = () => <EmptyState icon="lock" title="No access" description="Your role does not include permission to view this page. Ask an administrator if you need it." />

export default NoAccess
