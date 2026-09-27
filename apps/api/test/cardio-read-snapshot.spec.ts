import { Prisma } from '@prisma/client';
import { canonicalSourceSnapshot, sourceRevision, validateRawSessionSetSnapshot } from '../src/sessions/session-set-snapshot';
const row = {
  id:'source', sessionId:'session', exerciseId:'e_plank', clientCorrelationId:null,setNo:1,orderIndex:0,
  targetRepsLow:null,targetRepsHigh:null,targetTimeLowSec:30,targetTimeHighSec:60,targetRir:null,
  restSec:60,recommendedWeight:null,recommendedReps:null,reasonCode:'BASELINE',confidence:new Prisma.Decimal(0.5),
  rulesVersion:'2026.09.1',loadSemantics:'external_load' as const, assistanceStepKg:null,assistanceProvenance:null,
};
describe('T06 S2 discriminated snapshots',()=>{
 it('does not interpret cardio with resistance-shaped fields as resistance append source',()=>{
  expect(validateRawSessionSetSnapshot({...row,prescriptionKind:'steady_cardio'} as typeof row).status).toBe('invalid_raw');
 });
 it('preserves legacy canonical bytes and binds explicit kind to source revision',()=>{
  expect(canonicalSourceSnapshot({...row,prescriptionKind:null} as typeof row)).toBe(canonicalSourceSnapshot(row));
  expect(sourceRevision({...row,prescriptionKind:'resistance'} as typeof row)).not.toBe(sourceRevision(row));
 });
 it('binds intensity and fallback payload to cardio source identity',()=>{
  const cardio={...row,prescriptionKind:'steady_cardio',durationSec:600,intensitySeconds:{moderate:600,high:0,recovery:0}};
  expect(sourceRevision({...cardio,intensitySeconds:{moderate:599,high:1,recovery:0}} as typeof row)).not.toBe(sourceRevision(cardio));
 });
});

