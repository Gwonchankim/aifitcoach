import { Prisma } from "@prisma/client";
import { weekSwapRevision } from "../src/programs/week-swap-revision";

const date = new Date("2026-09-14T00:00:00Z");
const planned = {
  id:"p",sessionId:"s",exerciseId:"e",clientCorrelationId:null,orderIndex:0,setNo:1,
  targetRepsLow:8,targetRepsHigh:12,targetRir:2,restSec:90,targetTimeLowSec:null,targetTimeHighSec:null,
  recommendedWeight:new Prisma.Decimal(20),recommendedReps:8,reasonCode:"BASELINE",
  confidence:new Prisma.Decimal("0.50"),rulesVersion:"2026.08.1",loadSemantics:"external_load" as const,
  assistanceStepKg:null,assistanceProvenance:null,updatedAt:date,performedSets:[],
};
const source = {
  id:"s",programId:"g",scheduledDate:date,status:"scheduled" as const,focus:"upper",
  origin:"planned" as const,plannedSets:[planned],
};

describe("weekly swap canonical aggregate revision",()=>{
  it("is stable for relation ordering and decimal formatting",()=>{
    const second={...planned,id:"p2",orderIndex:1};
    expect(weekSwapRevision({...source,plannedSets:[planned,second]})).toBe(
      weekSwapRevision({...source,plannedSets:[{...second,confidence:new Prisma.Decimal(".5")},planned]}));
  });
  it.each([
    ["id","other"],["programId","other"],["scheduledDate",new Date("2026-09-15")],
    ["status","completed"],["focus","lower"],["origin","ad_hoc"],
  ])("session %s participates",(key,value)=>{
    expect(weekSwapRevision({...source,[key]:value})).not.toBe(weekSwapRevision(source));
  });
  it.each([
    ["id","p2"],["clientCorrelationId","c"],["sessionId","s2"],["exerciseId","e2"],
    ["orderIndex",1],["setNo",2],["targetRepsLow",9],["targetRepsHigh",13],["targetRir",3],
    ["restSec",120],["targetTimeLowSec",30],["targetTimeHighSec",60],
    ["recommendedWeight",new Prisma.Decimal(25)],["recommendedReps",9],["reasonCode","OTHER"],
    ["confidence",new Prisma.Decimal(".75")],["rulesVersion","2026.08.2"],
    ["loadSemantics","assistance"],["assistanceStepKg",new Prisma.Decimal(5)],
    ["assistanceProvenance","native"],["updatedAt",new Date("2026-09-15")],
  ])("planned %s participates",(key,value)=>{
    expect(weekSwapRevision({...source,plannedSets:[{...planned,[key]:value}]}))
      .not.toBe(weekSwapRevision(source));
  });
  it("performed membership, identity, completion and updatedAt participate",()=>{
    const performed={id:"f",plannedSetId:"p",updatedAt:date,completed:false};
    const input={...source,plannedSets:[{...planned,performedSets:[performed]}]};
    expect(weekSwapRevision(input)).not.toBe(weekSwapRevision(source));
    for (const patch of [{id:"f2"},{plannedSetId:"p2"},{updatedAt:new Date("2026-09-15")},{completed:true}]) {
      expect(weekSwapRevision({...input,plannedSets:[{...planned,performedSets:[{...performed,...patch}]}]}))
        .not.toBe(weekSwapRevision(input));
    }
  });
});
