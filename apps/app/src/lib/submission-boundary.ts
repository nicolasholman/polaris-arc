/** Invocation-local boundary, marked immediately before invoking a submission API. */
export class SubmissionBoundary {
 private submitted=false;
 enter(){this.submitted=true;}
 releaseUnsigned(release:()=>void){if(!this.submitted)release();}
}
