ULINK Video Work-through.


JD1
- check document is missing or not
- appointment appointment date/time & injury details.
- Check total claim amount matched with Document.
- Check claimant name & bank name is same.
- check bank info
- check member is in ayas sompo group a or b (excel sheet to be confirm)
- check member policy is in period or not.
- check treatment date on each voucher (pick the earliest)
- check member info (NRC & DOB & name) is same or not
- check claim appointment date is over 60 day or no (if yes rejected)
- sum all the bill amt to matched with claim amount
- filling up required property field & status
- reply member email acknowledge with canned response
- Upload Console the doc with formatted folder ${date-name(company)-ticketnumber}

  
- set status "JD1 - Complete Doc" (END)
- set status "JD1 - Pending Doc" (Exception)


JD2
- Doc Complete/Receive Date will be based on JD1 Complete Doc Date
- Recheck the member/policy info
- Sync member info (mobile, email, bank name, bank acct no, bank acct name)
- Prepare the new/amend claim
- for VS & DT should susspend code = IX - Claim Investigation & add Remark (claim status NC), fill the google excel sheet for manual confirm.
- filling up required property field & status


- set status "JD2 - Pending Approval" (END)
- set status "JD2 - Void" (Exception)



Excel Bank Account List Provided from Member
(JD1)
- Ticket Number
- Group
- Bank Name
- Bank Acc Name
- Bank Acc No
(JD2)
- Assign Agent
- Claim Number
- Processed By



Confirm Cases with Members/Shop
(shared google sheet, for confirm date & amount if vision/dental claim)


System Analyst Finding:
- Need confirm how to retrieve barcode from console.
- Also update console status
- Should the excel sheet move using console instead using excelsheet for JD4 payment check ?
- what is the shop excel sheet look like in the auto flow?