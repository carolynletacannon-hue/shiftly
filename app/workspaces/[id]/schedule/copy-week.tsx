"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addDays, localDate, shiftLabel } from "@/lib/scheduling/time";
import type { CopyPreview } from "@/lib/scheduling/copy-types";
import { copyWeekAction } from "./copy-actions";
export function CopyWeek({ orgId, week, hoursWarning }: { orgId: string; week: string; hoursWarning: number }) {
 const dialog = useRef<HTMLDialogElement>(null);
 const router = useRouter();
 const [source,setSource]=useState(addDays(week,-7));
 const [destination,setDestination]=useState(week);
 const [mode,setMode]=useState("all");
 const [strategy,setStrategy]=useState("merge");
 const [preview,setPreview]=useState<CopyPreview>();
 const [confirmed,setConfirmed]=useState(false);
 const [error,setError]=useState("");
 const [notice,setNotice]=useState("");
 const [pending,startTransition]=useTransition();
 function reset(){setPreview(undefined);setConfirmed(false);setError("");}
 function run(commit=false){ startTransition(async()=>{
   setError("");
   const result=await copyWeekAction(orgId,{source,destination,mode,strategy,token:commit?preview?.token:undefined});
   if(result.error){setError(result.error);setPreview(undefined);setConfirmed(false);return;}
   if(result.copied){dialog.current?.close();setNotice(`Copied to the week of ${destination}. Review the draft, then Publish when ready.`);router.push(`/workspaces/${orgId}/schedule?week=${destination}`);router.refresh();reset();}
   else setPreview(result.preview);
 }); }
 return <>
 <button className="button" onClick={()=>{reset();dialog.current?.showModal();}}>Copy Week</button>
 {notice&&<p role="status">{notice}</p>}
 <dialog ref={dialog} className="copy-week-dialog" aria-labelledby="copy-week-title">
 <h2 id="copy-week-title">Copy Week</h2>
 <p>Copy the source week’s saved working schedule, including open staffing slots. The source stays unchanged. Staff see changes only after Publish.</p>
 <form onSubmit={e=>{e.preventDefault();run();}}>
 <fieldset disabled={pending}>
 <label>Source week<input required type="date" value={source} onChange={e=>{setSource(e.target.value);reset();}} /></label>
 <label>Destination week<input required type="date" value={destination} onChange={e=>{setDestination(e.target.value);reset();}} /></label>
 <label>What to copy<select value={mode} onChange={e=>{setMode(e.target.value);if(e.target.value==='assignments')setStrategy('merge');reset();}}>
 <option value="all">Shift structure and employee assignments</option>
 <option value="structure">Shift structure only</option>
 <option value="assignments">Employee assignments onto matching shifts</option>
 </select></label>
 <label>Destination draft<select value={strategy} onChange={e=>{setStrategy(e.target.value);reset();}}>
 <option value="merge">Safely merge; keep existing work</option>
 {mode!=='assignments'&&<option value="replace">Replace existing draft</option>}
 </select></label>
 <p>Merge fills compatible open slots and keeps current assignments. Assignments only never creates shifts. Structure only keeps existing assignments when merging; choose Replace for an unassigned draft.</p>
 <button className="button" type="submit">{pending?'Checking…':'Preview copy'}</button>
 </fieldset>
 </form>
 {error&&<p role="alert" className="notice">{error}</p>}
 {preview&&<section aria-label="Copy preview" aria-live="polite">
 <h3>Preview: week of {preview.week}</h3>
 <p>{preview.added} slots added · {preview.assigned} assignments added · {preview.removed} slots replaced · {preview.skipped} skipped</p>
 <p>Source revision {preview.source_revision}; destination revision {preview.destination_revision}. {preview.published?'This week is published. Copy changes its draft only; the published schedule stays unchanged until Publish.':''}</p>
 {preview.warnings.length>0&&<ul>{preview.warnings.map((w,i)=><li key={i}>{w.message}{w.label?`: ${w.label}`:''}</li>)}</ul>}
 <h4>Projected employee hours</h4>
 <ul>{preview.hours.map(h=><li key={h.id}>{h.display_name}: {h.hours} hours{h.hours>hoursWarning?' — above weekly hours warning threshold':''}</li>)}</ul>
 <details><summary>Review all {preview.shifts.length} destination staffing slots</summary><ul>{preview.shifts.map(s=><li key={s.id}>{localDate(s.starts_at,preview.timezone)} · {s.label} · {shiftLabel(s.starts_at,s.ends_at,preview.timezone)} · {s.employee_id?preview.hours.find(h=>h.id===s.employee_id)?.display_name||'Assigned':'Open'}{s.is_required?' · Required':''}{s.notes?` · ${s.notes}`:''}</li>)}</ul></details>
 {strategy==='replace'&&<label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> I reviewed the preview and confirm replacing {preview.removed} existing draft slots and their assignments.</label>}
 <button className="button" disabled={pending||(strategy==='replace'&&!confirmed)} onClick={()=>run(true)}>{pending?'Copying…':strategy==='replace'?'Confirm replacement':'Confirm copy'}</button>
 </section>}
 <button className="button secondary" disabled={pending} onClick={()=>dialog.current?.close()}>Cancel</button>
 </dialog>
 </>;
}
