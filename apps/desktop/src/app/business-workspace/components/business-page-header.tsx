import { ApexPageHeader, type ApexPageHeaderProps } from '@/components/ui/apex-page-header'

export type BusinessPageHeaderProps = ApexPageHeaderProps

/** Shared Phase 1 page heading; it keeps page identity and the primary action aligned. */
export function BusinessPageHeader(props: BusinessPageHeaderProps) {
  return <ApexPageHeader {...props} />
}
