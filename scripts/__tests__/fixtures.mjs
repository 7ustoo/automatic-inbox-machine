/**
 * Real-shaped recruiter mail. Every fixture here is modelled on the actual
 * patterns that flood a contractor's inbox — including the ones that fool naive
 * keyword matching, which is why the awkward ones are in here at all.
 */

export const REJECTION_AFTER_INTERVIEW = {
  from: 'talent@bluewaveconsulting.com',
  fromName: 'Megan Ortiz',
  subject: 'Re: Cloud Security Engineer interview',
  body: `Hi Justin,

Thank you for taking the time to interview with our team last week. After careful
consideration, we have decided to move forward with other candidates whose
experience more closely matches the client's requirements.

We will keep your resume on file for future roles and wish you the best in your
job search.

Regards,
Megan Ortiz
Blue Wave Consulting`
};

export const ATS_ACK = {
  from: 'no-reply@myworkday.com',
  fromName: 'Workday Recruiting',
  subject: 'Thank you for applying to Northwind Systems',
  body: `Thank you for applying to Northwind Systems.

We have received your application for Senior Cloud Security Engineer. Our team is
reviewing your application and someone will reach out if your qualifications
match the needs of the role.

Job Description:
Title: Senior Cloud Security Engineer
Location: Austin, TX
We are seeking an experienced engineer to lead cloud security initiatives...

Please do not reply to this email.`
};

export const ICIMS_ACK_DULUTH = {
  from: 'duluthtrading+autoreply@talent.icims.com',
  fromName: 'Duluth Trading @ iCIMS',
  subject: "We've got your application for Duluth Trading Company!",
  body: `Hello Justin,

Thank you for taking the time to apply for our Senior Network Engineer opening.
Right now, we're reviewing applications. If your background aligns with what we
need, you'll be hearing from one of our recruiters shortly to chat about next
steps. We truly appreciate your interest in Duluth Trading Company.

This is an automated email response. Please do not reply.`
};

export const ATS_CONDITIONAL_INTERVIEW = {
  from: 'ctg+autoreply@talent.icims.com',
  fromName: 'CTG',
  subject: 'Thank you for applying at CTG',
  body: `Thank you for your interest in the IAM Architect role. Our hiring team
is currently reviewing all applications. If your profile meets our hiring needs,
one of our recruiters will reach out to schedule an interview. This is an
automated email response. Please do not reply.`
};

export const ATS_DIRECT_INTERVIEW = {
  from: 'bcbsri@myworkday.com',
  fromName: 'Blue Cross Blue Shield RI',
  subject: 'Phone Screen Availability',
  body: `Thank you for applying to the Senior Technical Software Architect role.
What is your availability for a brief phone screen to discuss the role and your
background?`
};

export const APPLICATION_VERIFICATION = {
  from: 'company+autoreply@talent.icims.com',
  fromName: 'Company Careers',
  subject: 'Application verification required',
  body: `Please verify your email to complete your job application. If selected
later, a recruiter may contact you to schedule an interview. This is an automated
message and replies are not monitored.`
};

export const FUNCTION_HEALTH_RECEIPT = {
  from: 'no-reply@gem.com',
  fromName: 'Function Health Recruiting',
  subject: 'Re: Thank you for your interest in our Staff Software Engineer opportunity at Function Health!',
  body: `Hi Justin,

Thank you so much for applying to our Staff Software Engineer opportunity! We
are a small recruiting team, so thank you for your patience as we manually
review everyone's resumes. We are excited to chat with you soon.`
};

export const KENTRO_APPLICATION_CLOSED = {
  from: 'brooks.keener@kentro.us',
  fromName: 'Brooks Keener',
  subject: 'Application Update - Remote System Administrator',
  body: `Dear Justin,

We will not be moving forward with next steps for the Remote System
Administrator position. We are finalizing steps with a qualified candidate and
will not be pursuing others at this time. We wish you the best.`
};

export const GOVERNMENTJOBS_MARKETING = {
  from: 'membership@governmentjobs.com',
  fromName: 'GovernmentJobs.com',
  subject: 'Get discovered by employers on GovernmentJobs.com',
  body: `Increase your odds of landing a job. Upgrade your free membership to
receive notifications from potential employers and access interview questions
and resume samples. Upgrade now. Unsubscribe.`
};

export const CALENDLY_NON_INTERVIEW_REMINDER = {
  from: 'notifications@calendly.com',
  fromName: 'George Hoffman (via Calendly)',
  subject: 'Reminder: 15 min touch base with George Hoffman tomorrow',
  body: `This is a friendly reminder that your 15 min touch base is tomorrow.
Hello - this is a 15 min touch base. Not an interview. I look forward to
speaking with you. Make changes to this event: reschedule or cancel.`
};

export const RECEIPT_WITH_COMPENSATION_BOILERPLATE = {
  from: 'noreply@candidates.workablemail.com',
  fromName: 'Workable',
  subject: 'Thanks for applying to Keywords Studios',
  body: `Thanks for applying to Keywords Studios. We received your application
and will review it. The listed compensation range is $80,000-$100,000 and the
posting includes W2 rate information. Please do not reply to this email.`
};

export const INTERVIEW_REQUEST = {
  from: 'priya.n@stellartechpartners.com',
  fromName: 'Priya Nair (Sr. Recruiter)',
  subject: 'Interview - Sr. Java Developer - Deloitte',
  body: `Hi Justin,

Hope you are doing well.

The client would like to speak with you regarding the Sr. Java Developer position
at Deloitte. Can you please share your availability for a 30 minute screening
call this week? They are flexible Tuesday through Thursday afternoons.

Once you confirm I will send the Teams invite.

Thanks,
Priya Nair
Stellar Tech Partners
(469) 555-0182`
};

export const RTR_REQUEST = {
  from: 'raj@apextalentgroup.com',
  fromName: 'Raj Kumar',
  subject: 'RTR needed - Cloud Security Architect - Fidelity',
  body: `Hi Justin,

Please find the requirement below.

Job Title: Cloud Security Architect
Client: Fidelity Investments
Location: Remote
Duration: 12 months
Rate: $85/hr on W2

I need your right to represent before I can submit your profile to the client.
Kindly reply back with your written confirmation so I can submit today.

Thanks,
Raj Kumar
Apex Talent Group`
};

export const RATE_REQUEST = {
  from: 'lisa@corebridgestaffing.com',
  fromName: 'Lisa Chen',
  subject: 'Re: DevOps Engineer - 100% Remote',
  body: `Justin,

Great speaking with you. What is your expected hourly rate for this role? The
client has a max bill rate of $78/hr on C2C but there may be some flexibility for
the right candidate.

Please confirm your rate and I will move forward.

Lisa Chen
CoreBridge Staffing`
};

export const NEW_REQ_REMOTE = {
  from: 'sandeep@nexusitsolutions.com',
  fromName: 'Sandeep Reddy',
  subject: 'URGENT :: Sr. Cloud Security Engineer :: 100% Remote :: W2 Only',
  body: `Hello,

We have an immediate requirement with our direct client. Please find the job
description below and let me know if you are interested.

Job Title: Sr. Cloud Security Engineer
Client: Charles Schwab
Location: 100% Remote (USA)
Duration: 12+ months contract
Rate: $75/hr on W2
Visa: USC/GC only

Responsibilities:
- Design and implement cloud security controls across AWS and Azure
- Lead incident response for cloud workloads
- Partner with platform teams on IAM and network segmentation

Kindly share your updated resume if interested.

Thanks,
Sandeep Reddy
Nexus IT Solutions`
};

export const NEW_REQ_ONSITE_LOWRATE = {
  from: 'mike@tristatetech.com',
  fromName: 'Mike Delgado',
  subject: 'Security Analyst - Onsite Dallas TX - Immediate need',
  body: `Hi,

We have an opening for a Security Analyst.

Job Title: Security Analyst
Client: Tenet Healthcare
Location: Dallas, TX - onsite 5 days, local candidates only
Duration: 6 months
Rate: $45/hr on W2

Let me know if you are interested.

Mike Delgado
TriState Tech`
};

export const DUPLICATE_REQ = {
  from: 'anita@brightpathresourcing.com',
  fromName: 'Anita Sharma',
  subject: 'Cloud Security Engineer (Senior) - Remote - Schwab',
  body: `Hi Justin,

I have an urgent opening with a direct client.

Job Title: Senior Cloud Security Engineer
Client: Charles Schwab
Location: Remote
Duration: 12 months
Rate: $72/hr W2

Responsibilities:
- Design and implement cloud security controls across AWS and Azure
- Lead incident response for cloud workloads
- Partner with platform teams on IAM and network segmentation

Please let me know if you are interested and share your updated resume.

Anita Sharma
BrightPath Resourcing`
};

export const JOB_BOARD_ALERT = {
  from: 'jobalerts-noreply@linkedin.com',
  fromName: 'LinkedIn Job Alerts',
  subject: '27 new jobs for "cloud security engineer"',
  body: `27 new jobs matching your search

Senior Cloud Security Engineer - Acme Corp - Remote
Cloud Security Analyst - Globex - Austin, TX
Security Engineer II - Initech - Remote

See all jobs matching your search preferences.
You are receiving this email because you set up a job alert.
Unsubscribe from these emails.`
};

export const SENSITIVE_ASK = {
  from: 'onboarding@pinnaclestaff.com',
  fromName: 'Pinnacle Onboarding',
  subject: 'Documents needed before submission - Cloud Engineer',
  body: `Hi Justin,

Before we submit you to the client we need the following:

- Last 4 digits of your SSN
- Date of birth (MM/DD)
- A copy of your driver's license

Please reply with these details today. Also confirm your rate of $80/hr.

Thanks,
Pinnacle Onboarding`
};

/** A chase on an RTR thread is still an RTR ask — the subject carries the intent. */
export const RTR_FOLLOW_UP = {
  from: 'raj@apextalentgroup.com',
  fromName: 'Raj Kumar',
  subject: 'Re: RTR needed - Cloud Security Architect - Fidelity',
  body: `Hi Justin,

Just checking in - did you get my last email? Any update on this?

Thanks,
Raj`
};

/** The same chase with a neutral subject carries no actionable ask at all. */
export const FOLLOW_UP = {
  from: 'raj@apextalentgroup.com',
  fromName: 'Raj Kumar',
  subject: 'Re: Cloud Security Architect - Fidelity',
  body: `Hi Justin,

Just checking in - did you get my last email? Any update on this?

Thanks,
Raj`
};

export const QUOTED_THREAD = {
  from: 'lisa@corebridgestaffing.com',
  fromName: 'Lisa Chen',
  subject: 'Re: DevOps Engineer',
  body: `Sounds good, I will let you know.

Lisa

On Tue, Aug 4, 2026 at 9:14 AM Justin Williams <me@example.com> wrote:
> Can you please schedule an interview with the hiring manager?
> I am available all week for a screening call.
>
> Thanks`
};
