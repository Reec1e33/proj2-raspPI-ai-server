import { CircleCheck, Gauge, OctagonAlert, TriangleAlert } from 'lucide-react';
import type { ThrottlingStatus } from '../api/types';
import { THROTTLE_CONDITIONS } from '../lib/throttling';
import { EmptyState, Panel } from './Panel';

function Flag({ on, scope }: { on: boolean; scope: 'now' | 'occurred' }) {
  if (!on) {
    return (
      <span className="inline-flex items-center gap-1 text-ink-secondary">
        <CircleCheck aria-hidden className="size-3.5 text-good" />
        No
      </span>
    );
  }
  const Icon = scope === 'now' ? OctagonAlert : TriangleAlert;
  return (
    <span className="inline-flex items-center gap-1 font-medium text-ink">
      <Icon
        aria-hidden
        className={`size-3.5 ${scope === 'now' ? 'text-critical' : 'text-warning'}`}
      />
      Yes
    </span>
  );
}

interface ThrottleStatusProps {
  throttling: ThrottlingStatus | undefined;
}

/** The firmware `get_throttled` flags: what is happening now vs. since boot. */
export function ThrottleStatus({ throttling }: ThrottleStatusProps) {
  return (
    <Panel
      title="Power and throttling"
      description={
        throttling?.raw ? (
          <>
            Firmware flags <code className="font-mono">{throttling.raw}</code>
          </>
        ) : (
          'Firmware get_throttled flags'
        )
      }
    >
      {!throttling ? (
        <EmptyState icon={Gauge} title="No data yet" />
      ) : !throttling.supported ? (
        <EmptyState
          icon={Gauge}
          title="Not supported on this host"
          detail="Throttle flags come from the Raspberry Pi firmware (get_throttled or vcgencmd)."
        />
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="text-ink-secondary">
            <tr className="border-b border-line">
              <th scope="col" className="py-2 font-medium">
                Condition
              </th>
              <th scope="col" className="py-2 font-medium">
                Now
              </th>
              <th scope="col" className="py-2 font-medium">
                Since boot
              </th>
            </tr>
          </thead>
          <tbody>
            {THROTTLE_CONDITIONS.map((condition) => (
              <tr key={condition.label} className="border-b border-line last:border-0">
                <th scope="row" className="py-2.5 font-normal text-ink">
                  {condition.label}
                </th>
                <td className="py-2.5">
                  <Flag on={throttling[condition.now]} scope="now" />
                </td>
                <td className="py-2.5">
                  <Flag on={throttling[condition.occurred]} scope="occurred" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
