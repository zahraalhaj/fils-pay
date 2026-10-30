# FilsPay bugs, explained simply

This is the plain-language version of [BUGS.md](BUGS.md). Each bug keeps the
same number in both files, so you can look up the technical details there.

**Total: 80 items** · ✅ 67 fixed · 🔴 3 confirmed, not fixed · ❓ 0 suspected · 🟡 0 worked around · ➖ 10 not a bug

Each heading starts with a running count (1, 2, 3 …). The number in brackets at the end, like (#15), is the bug's ID in [BUGS.md](BUGS.md); IDs were given in the order bugs were found, so they aren't in sequence.

**Status:** ✅ fixed · 🔴 confirmed, not fixed yet · ❓ suspected, not confirmed yet · ➖ checked, not a bug

## How sure are we?

- **Proven** — we made it happen on the running app or ran the code: #1, #3, #4, #7, #13, #14, #15, #17, #19, #45, #28, #29, #33, #34, #36, #38, #39, #40, #49, #53, #57, #65, #73.
- **Confirmed in the code** — we traced it line by line against the rules, but haven't made it happen yet: most other 🔴 items.
- **Failing test, cause unknown** — #37, #42: something is wrong, but it could be the test rather than the app.
- **❓ suspected** — plausible but not proven; may turn out to be nothing.
- **➖ not a bug** — we checked and it was fine. Some "bugs" in this repo are deliberate decoys.

## A few words first

- **FilsPay** is a card-payment company in Bahrain. Shops ("merchants") use it
  to take card payments, and FilsPay pays the money out to them.
- **BD and fils:** 1 Bahraini dinar (BD) = **1000 fils**. Many bugs here come
  from code treating it as 100, like dollars and cents.
- **Merchant dashboard:** the website shops use to see their own payments.
- **Admin console:** the website FilsPay staff use to run everything.
- **Ledger:** the official record of every money movement. If anything
  disagrees with the ledger, the ledger is right.
- **Settlement / payout:** each day FilsPay adds up a shop's sales, takes its
  fee, and pays the rest to the shop.
- **Scheme file:** the daily file sent to Visa/Mastercard listing the payments.
- **OTP:** the one-time code you type after your password.

---

## Money calculated wrong

### 1. ✅ Imported corrections were 10 times too small (#1)
Finance uploads spreadsheets of manual corrections. The system read "4.75 BD"
as 0.475 BD, because it assumed 100 fils per dinar instead of 1000. It also
quietly dropped a third decimal (4.755 became 4.750).
**Fixed:** amounts are now read correctly, and anything with too many decimals
is rejected instead of silently cut.

### 2. ✅ Promotional discounts were 10 times too small (#35)
Same mistake as #1, in a different place. It also accepted nonsense like
"4.75abc".
**Fixed** the same way.

### 3. ✅ The same correction file can be imported twice (#2)
If someone double-clicks Import, every correction is applied twice. This already happened once in August. Strictly this is a missing safety feature rather than broken code.
**Fixed:** the system now remembers every file it has imported. Uploading the same rows again, even under a different file name, is refused unless the person confirms on purpose that they really want it posted twice.

### 4. ✅ The daily Visa/Mastercard file rounds amounts up instead of down (#3)
The rules say amounts must be cut down to 2 decimals (4.745 → 4.74). The
code rounded instead (4.745 → 4.75). So the file always claimed slightly more
than the real total. This is why the card network's statement was "always a
few fils higher" (finance memo, item 1). People blamed Visa for this; it was
our file.
**Proven:** in the local data, 7 lines were too high and none were too low.
**Fixed:** the file now uses the cut-down amount, and the database refuses any
new line where the two figures disagree. The 7 old lines were left as they are,
because they're what was actually sent; finance needs to book that 70 fils
difference.

### 5. ✅ Payouts use imprecise maths (#4)
The payout amount is calculated with a low-precision number type. On large
batches the shop gets paid 1 fils too little. Example: Delta Wholesale's batch
of 20,000.123 BD. The "lifetime payout estimate" drifts for the same reason.
**Fixed:** payouts and the lifetime estimate now use exact whole-fils maths.

### 6. ✅ Fee recalculation changes payouts that were already paid (#6)
"Recalculate MDR" is supposed to post a correction for the future. Instead it
also rewrites the numbers on batches that were already paid, so the records
no longer match what was actually sent to the bank.
**Fixed:** paid batches are never changed now; the correction is still recorded separately in the ledger.

### 7. ✅ Split payouts lose a few fils every time (#43)
Some marketplaces split each payout between several sub-shops. Each share is
rounded on its own, and the leftover fils are never paid to anyone, yet the
payout is marked as complete. A few tens of fils go missing every batch.
**Fixed:** the leftover fils now go to the largest share, so the parts always add up to the whole. Payouts are refused if the shares don't add up to 100%.

### 8. ✅ The dashboard shows a different fee from the one charged (#44)
The dashboard shows the most recently *typed-in* fee row, but billing uses the
row that is actually *in effect today*. After a backdated correction, a shop
could see 2.45% while being charged 2.25%.
**Fixed:** the dashboard now shows the rate actually in effect, worked out the same way billing does.

### 9. ✅ The admin console shows staff the wrong fee rate too (#69)
The merchant list's MDR column shows the shop's default rate, not the rate in
its fee agreement. Alpha shows 2.50% but is actually charged 2.25%.
**Fixed:** the list now shows the rate actually charged.

### 10. ➖ Brand-new shops count as "live" before they're approved (#70)
A shop that has only just signed up is marked active and live, so the daily
payout run processes it like a real shop. It can't take payments until approved,
so the main harm is confusion and wasted work.
**Not a bug:** "active" here only means "not suspended or closed". Whether a shop is approved is tracked separately, and an unapproved shop already can't take any payment, so no money is affected. The huge number of "live" shops on the test computer are leftovers from automated tests.

### 11. ✅ Shops can refund more than they were paid (#46)
If a shop authorised 10 BD but only collected 4 BD, the system still allows a
refund of the full 10 BD. That means 6 BD leaves FilsPay that was never
received.
**Fixed:** the limit is now what was actually collected. Tested: 10 BD authorised, 4 BD collected → a 10 BD refund is refused.

### 12. ✅ Two refunds at the same moment can both go through (#50)
If two refund requests for the same payment arrive at the same time, both
check the "already refunded" total before either has saved, so both pass and
both send money back. Normal payments lock the record while they work;
refunds don't. (Ticket FP-209.) Refunds aren't switched on yet, so this
would bite as soon as they are.
**Fixed:** the payment is locked and the refund amount reserved before the bank is asked, so a second request at the same moment is refused. Tested: two 6 BD refunds on a 10 BD payment → one goes through, one is refused.

### 13. ✅ A shop could refund another shop's payment (#51)
The refund code finds the payment by its ID only and never checks it belongs
to the shop asking. Like #50, this is waiting to go live when refunds are
switched on.
**Fixed:** refunds only find payments belonging to the shop asking. Tested both directly and through the API.

### 14. ✅ The reconciliation check guessed fees instead of using the real ones (#55)
Reconciliation compares the ledger with what's waiting to be paid out. It
re-guessed each payment's fee from the shop's standard rate, ignoring special
negotiated rates, and it left out refunds. For Alpha it showed a 25 fils gap
that wasn't real.
**Fixed:** it now uses the fee actually charged on each payment and includes
refunds. Checked on the live app: the gap is 0.

### 15. ✅ Shops' negotiated discounts weren't applied to payment-link sales (#60)
Some shops have a discount on FilsPay's fee. It was only applied when a sale
went through the API, and only as a separate step afterwards. Sales through
payment links never got it, so those shops were overcharged on every link
payment, and our records disagreed with the payout system.
**Fixed:** the discount is now applied as part of every sale, in one step.
Tested: a shop with a 20% discount pays 200 fils instead of 250.

### 16. 🔴 A platform-wide fee discount is switched on without approval, and its counter breaks (#66)
Once FilsPay's total sales pass 2 million BD, every shop automatically gets
0.15% off its fee. Yousif said this must not go live until finance agreed in
writing, and nobody can find that approval. On top of that, the running total
is stored in a number type that tops out at about 2.15 million BD: just after
the discount starts, the counter wraps around to a negative number, so the
discount switches itself on and off at random.
**Partly fixed:** the counter no longer breaks. Whether the discount should be on at all is a business decision for finance.

### 17. ✅ Partial refunds might return slightly too much fee (#5)
Each partial refund rounds its fee on its own. Over several partial refunds,
the total fee returned might add up to more than the original fee.
**Fixed:** the fee given back is worked out on the running total, so it always adds up to exactly the fee charged. Tested: a 3 fils fee refunded in two halves gives back 3, not 4. Discounts are taken into account too.

### 18. ✅ The settlement summary double-counts some sales (#7)
For shops that collect one order in several parts, the summary shows about
38% more than the actual batches.
**Fixed:** for a payment collected in three parts, the summary added the running total each time (part 1, then parts 1+2, then all three), so 9 BD showed as 27 BD. We proved it with a test. It now adds each part once, the same way the payouts do. The July write-up blamed a "timing difference", which was wrong.

### 19. ➖ One fee calculator rounds differently from the rest (#8)
One partner-facing fee calculator rounds half-up, while the rules say
"half-to-even" (banker's rounding).
**Not a bug:** that calculator is old code that nothing uses any more. The real fee calculation rounds the correct way.

---

## Balances shown wrong

### 20. ✅ The "Rebuild cached balances" button sets balances to wrong numbers (#15)
This button is supposed to recalculate what FilsPay owes each shop. Instead of
using the ledger, it adds up every card payment the shop ever had, ignoring
fees, payouts and refunds. The command-line version of the same tool does it
correctly.
**We reproduced it:** Alpha Retail is really owed **136,496 BD**, but the button
shows **7,326 BD** ("135K went to 7K", finance memo). Delta Marketplace is owed
22,677 BD, but the button shows **0**.
**Fixed:** the button now uses the ledger, exactly like the command-line tool. Checked on the live app: Alpha stays at 136,496 BD.

### 21. ➖ "Adjust balance" hides problems (#16)
Support can type in a new balance by hand without any ledger record. This is
how the wrong numbers from #15 kept getting "fixed" by hand and never
investigated.
**Not a bug in the code:** it works exactly as an approved design decision (ADR-0006) says: it only changes the number shown on screen, not the official ledger. Whether that rule is a good idea is a question for finance. The problem it used to hide (#15) is fixed.

### 22. ✅ A button quietly turns test shops into real shops (#17)
"Recompute transaction statuses" switches off a shop's test mode without
asking. Test shops (like Gamma) then get included in real daily payouts.
**Fixed:** recomputing statuses no longer touches test mode. Tested: a test shop stays a test shop.

---

### 23. ✅ The dashboard couldn't show how much had been refunded (#58)
The payment details never included the refunded amount (a code comment
claimed they did), so the dashboard couldn't tell how much could still be
refunded.
**Fixed:** the refunded amount is now sent and shown on the payment page.

## Card payments and payment links

### 24. ✅ A payment link can be paid twice (#9)
A payment link should only work once. If the first customer's card takes
longer than 60 seconds, the link opens up again and a second customer can pay
too. This caused the May incident, which was wrongly blamed on duplicate
messages from the bank.
**Fixed:** only the buyer who still holds the link can be charged, and the link is marked paid in the same step as the payment. Tested by re-creating the incident: one charge, and the slow buyer's hold is released.

### 25. ✅ Nothing stops a second payment on the same link (#10)
The safety rule "one successful payment per link" was marked as done but was
never actually added.
**Fixed** by the same change.

### 26. ✅ Messages from the bank aren't de-duplicated (#11)
If the bank sends the same notification twice, FilsPay records it twice. A
"fix" for this was announced in May but doesn't exist.
**Fixed:** a repeated message is stored only once.

### 27. ✅ One shop can cancel another shop's payment link (#45)
A shop can cancel any payment link on the platform if it knows the link's ID,
even links that belong to a different shop.
**Fixed:** a shop can now only cancel its own links. Tested: the other shop gets "not found" and the link stays active.

### 28. ✅ Expired payment links can still be paid (#48)
The payment page trusts the time the customer's device says it is. Anyone can
claim it's an earlier date and pay a link that has already expired.
A real customer reported exactly this (ticket FP-187). The design documents allow it for offline card terminals, but the public payment page lets anyone use it.
**Fixed:** the payment page's time is only trusted within 5 minutes of the server's. Tested: an expired link with a 3-day-old time is refused.

### 29. ➖ Card holds may come back after being cancelled (#12)
A "hold" reserves money on a customer's card. After a cancellation, some holds
were seen switching back to active.
**Not a bug:** nothing in the system can switch a cancelled hold back on. The stuck holds in May were most likely caused by the old clean-up script (#40), which is fixed.

### 30. ✅ Reusing a request ID on a different payment isn't blocked (#13)
The API should reject the same request ID being used for a different
transaction. This isn't tested and may not be enforced.
**Fixed:** if a shop reused the same request ID to collect a *second* payment, the system replied "success" with the first payment's details, and the second payment was never collected. We proved it with a test. Now that request is refused with a clear error.

### 31. ✅ The public refund API isn't connected (#32)
The refund API answers "not implemented".
**Fixed** as part of the refunds work (FP-300): shops can now refund through the API.

### 32. ✅ Refunds crashed if no reason was given (#36)
**Fixed:** a missing reason is now saved as "unspecified".

---

## Security

### 33. ✅ Nobody could log in to a live (production) copy of the app (#72)
The login code was never actually sent anywhere: the "send" step only wrote
to the server's log, and in production it left the code out. There's also no
sign-up page in either app. So on a real deployment, nobody could ever log in.
**Fixed:** codes are now emailed (any standard email service), never shown or
logged in production, and the server won't start in production without email
set up. Tested with a local test inbox: the code arrived by email and login
worked.

### 34. ✅ The login code could be shown on screen in production (#71)
In development the login code is shown on the login page on purpose, so you
can log in without real email or SMS. But one setting could switch that on in
production too, which would make the code pointless.
**Fixed:** production can never show the code, whatever the settings say.
Development still shows it.

### 35. ✅ You could log in without the OTP code (#39)
Typing just the password was enough to use the merchant API. The second step
did nothing.
**Fixed and tested on the live app:** password only is now refused, and
password plus code works.

### 36. ✅ Secret codes were guessable (#21)
OTP codes, payment link addresses and admin invite codes were made with a
predictable random generator.
**Fixed:** they now use a secure generator.

### 37. ✅ "View as merchant" gave staff full control (#22)
When FilsPay staff viewed a shop's account, senior staff got full owner rights
instead of read-only access. Staff who had been disabled could keep using it.
**Fixed:** it is always read-only now, and disabled staff are blocked.

### 38. ✅ Anyone can send fake fraud reports (#34)
The bank sends signed "fraud review" messages. FilsPay accepts messages
**with no signature at all**.
**We proved it:** a made-up "confirmed fraud" message on an Alpha Retail
payment was accepted and saved. Old signed messages can also be re-sent
forever.
**Fixed:** unsigned messages are refused, and signatures older than 5 minutes are refused, so old messages can't be replayed.

### 39. ✅ Replaced API keys keep working (#47)
When staff "rotate" a shop's API key, a new key is created but the old one is
never switched off. Every key ever rotated still works.
**Fixed:** a replaced key keeps working for 24 hours so the shop can switch, then stops.

### 40. ✅ Staff can approve their own large credits (#25)
Big credits need a second person to approve them. The system checks this by
comparing *display names* instead of user IDs. The size check also ignores
part of the amount, so some large credits skip approval entirely.
**Fixed:** approvers are compared by their account, not their name.

### 41. 🔴 A secret key is saved in the code repository (#26)
A real signing secret was committed to the code where anyone with access can
read it.
**Partly fixed:** the file is no longer stored with the code, and the settings now stop it being added again; there is a blank template to copy instead. **Still to do:** the old key is still in the code's history, so it must be replaced with a new one at the bank's end.

### 42. ➖ Error codes reveal that other shops' data exists (#23)
Asking for another shop's data returns "forbidden" instead of "not found",
which confirms the item exists.
**Not a bug:** no rule asks for a different error, and the error is given before the system even looks anything up, so it reveals nothing about the other shop.

### 43. ✅ Disabled shop users might still be able to log in (#41)
The login check doesn't verify that the shop user is still active.
**Confirmed:** see the next item — it's part of a bigger problem.
**Fixed** with the item below.

### 44. ✅ A shop could read another shop's transaction report (#73)
The transactions report lets a shop that splits its payouts look at its
"child" shops. But the check only asked "is this *somebody's* child shop?",
not "is it *yours*?", so any shop could read any child shop's payments.
**Fixed:** a shop can now only see child shops that really belong to it. Proven with a test. A related report summary that didn't check who was asking now requires login too.

### 45. ✅ Suspended shops can keep taking payments that never get paid out (#61)
A suspended or closed shop can't log in again, but anyone already logged in,
and any API key the shop already has, keeps working, and taking a card payment
doesn't check the shop's status. The daily payout skips suspended shops, so
that money is taken from customers and then never paid to anyone.
**Fixed:** a suspended shop's API keys and logins stop working, and new payments are refused.

### 46. ✅ Staff "viewing as" a shop could collect or cancel its payments (#49)
An API key can do things that only the shop owner should be able to do. Also,
when staff act on a shop's behalf, the records can't tell staff from the shop.
**Fixed:** "view as merchant" is meant to be read-only, but staff using it could still collect or cancel the shop's card payments, and it was recorded as if the shop did it. We proved it with a test. Now anything except viewing is refused. (The other half of the report, that API keys skip role checks, is **not a bug**: keys are created by the shop's owner and are meant to have full access.)

### 47. ➖ The admin login cookie is set twice (#24)
Suspected to be a security problem. Checked: the second time just extends how long the login lasts, and admin logins do require the code. Not a bug.

### 48. ✅ The OTP code could be guessed many more times than allowed (#53)
Each "resend code" gives a fresh set of guesses, every 30 seconds, with no
overall limit. The chance of guessing is small, but there's no cap.
**Fixed:** you only get 5 tries at the 6-digit login code. But sending 20 guesses at the same instant let all 20 be checked, and asking for a new code gave you 5 fresh tries every 30 seconds. We proved both with tests. Now each try is counted before it's checked, and a new code keeps the tries already used. This applies to the staff login too.


### 49. ✅ The admin activity log can be edited or deleted (#67)
Every admin action is written to an activity log, which is supposed to be
permanent. A code comment says a database rule prevents changes, but no such
rule exists, so the log can be quietly altered. It also doesn't record what
permission level the admin had at the time.
**Fixed:** the database now blocks deleting or rewriting log entries, and each entry records the admin's permission level at the time.

### 50. ✅ The money ledger can be edited after the fact (#68)
The ledger is meant to be write-once: mistakes are fixed with new correcting
entries, never by changing old ones. In fact old entries can be changed, as
long as both sides of an entry still add up. A comment claims otherwise.
**Fixed:** the database now blocks changing or deleting ledger entries.

---

## Timing and dates

### 51. ✅ The daily payout runs at 3 a.m. instead of just after midnight (#20)
The scheduler uses UK/UTC time to decide what "today" is, so it runs about 3
hours late in Bahrain.
**Fixed:** the scheduler now uses Bahrain time, so the close runs just after midnight.

### 52. ✅ The March clean-up script is unsafe to run (#19)
- **Running it twice applies it twice.** It has no way to tell it already ran
  (finance saw the gap double on staging), and it has no "test run" mode.
- **It uses the wrong month boundaries:** UTC instead of Bahrain time.
- **It charges the shop** for the rounding leftovers instead of recording them
  in FilsPay's own suspense account.
**Fixed:** it only does a test run unless told `--apply`, refuses to run a second time, uses Bahrain months, and records leftovers in FilsPay's own accounts instead of charging the shop. Tested: the second run said "already posted, nothing done".

### 53. ➖ Analytics dates were suspected to be off by one day (#18)
Checked: the date calculation is actually correct.

---

## Webhooks (automatic notifications to shops)

### 54. ✅ Webhook signatures don't match the message sent (#14)
FilsPay signs each notification so shops can trust it, but it signs one copy
of the message and sends a separately-built copy. If the two differ, the
shop's check fails. A fix existed on Yousif's deleted branch `ya/sign-raw`.
**Proven:** we showed the signed text and the sent text side by side and they differ. A real shop (Beta) rejected 59 of 220 notifications (27%) in September for exactly this reason.
**Fixed:** we now sign exactly the text we send.

### 55. ✅ Shops get two "your payout is on the way" messages (#52)
Two parts of the system can check "has this payout been announced yet?" at
the same moment, both see "no", and both send the message. A promised
safety lock for exactly this was marked as done but was never built.
(Incident 2026-08-21.)
**Fixed:** the database now allows only one payout message per payout. Tested with 8 runs at once.

### 56. ✅ The webhook retry timing test fails (#37)
The automatic retry schedule doesn't behave as its test expects.
**Fixed:** the test was wrong. It ignored the deliberate random variation in retry timing.

---

## Running the system

### 57. ✅ Database errors can hide the real problem (#27)
If undoing a failed database change also fails, the original error is lost.
**Fixed:** the original error is kept.

### 58. ✅ The app won't start without extra setup (#28)
The built-in development encryption key is the wrong length, so the API
crashes on start-up unless you provide your own key.
**Fixed:** the built-in development key is now the right length.

### 59. ✅ The Docker setup was incomplete (#29)
Two build files that the setup needs are missing, so the services can't be
started with Docker.
**Fixed:** the two missing build files are written, and both service images now build and start. We also found the setup never actually passed its settings file to the services, and the payout service would stop at start-up without a shared password. Both are fixed.

### 60. ✅ Exporting transactions loads everything into memory at once (#33)
The release notes say the export streams data bit by bit; it doesn't. Big
exports can crash the server.
**Fixed:** the export now sends the file in pieces of 1,000 rows, so memory use stays small however big the export is. The half-built version of this that already existed would have skipped or repeated rows; that is fixed too. Tested: 1,234 rows came out exactly once each.

### 61. ✅ The websites couldn't talk to the API (#38)
The API doesn't allow the dashboards' web addresses to call it, although a
code comment claims it does.
**Worked around** for local use with a dev proxy.
**Fixed properly:** the API now accepts requests from the shop dashboard and the admin console (and only those), so the earlier workaround is no longer needed. In production the allowed addresses have to be set explicitly.

### 62. ✅ The hold clean-up script could delete every hold (#40)
On a night with nothing to clean up, the script would delete **all** card
holds. It also deleted holds instead of marking them expired.
**Fixed:** it now only marks old holds as expired, in one safe step.

### 63. ➖ The reporting service writes rows with no shop attached (#42)
The analytics service saves some figures without saying which shop they belong
to, so they fail to save.
**Checked: not an app bug.** Another set of tests leaves fake, empty records in the shared test database, and the reporting tests trip over them. On a clean database they pass.

### 64. ✅ Reports couldn't record refunds at all (#56)
The reports table had nowhere to store refunds, the half-written code listened
for the wrong message name and used the wrong day, and the admin refund summary
matched refunds to payments by the wrong ID, so it was always empty.
**Fixed:** refunds are now counted on the right Bahrain day, and the summary is
rebuilt correctly. (Nothing refreshes that summary automatically yet.)

### 65. ✅ One bad record can stop the reports updating forever (#57)
If the reporting service meets a broken record, it retries it again and again
and never moves on, so every later sale and refund is missing from the reports.
We saw this happen locally.
**Fixed:** if the reports keep failing on the same record, the system now sets that record aside in a separate list for someone to look at, and carries on with everything else. A record like this was blocking the reports on the test computer today; it has now been set aside.

### 66. 🔴 A request that crashes half-way can block that request ID forever (#62)
Each request carries an ID so retries don't double-charge. If the server
crashes in the middle, that ID stays marked "in progress" and every retry is
refused. A clean-up script that supposedly handles this doesn't exist.
**Left open on purpose:** only refunds are affected (card payments clean up after themselves). An automatic clean-up could make a stuck refund go through twice, so this needs a way to ask the bank whether the refund really happened. That is a design decision, not a quick fix.

### 67. ✅ The reports can silently miss a payment (#74)
The reporting service keeps a bookmark: "I've handled everything up to record
number N". But records can be saved slightly out of order, so a record with a
lower number can appear after the bookmark has already moved past it, and
then it is never counted. The previous developer listed this as unfinished.
**Fixed:** we reproduced it (two payments, only one reached the reports). The
bookmark now only moves past records whose save has fully finished, so a
slow save is picked up as soon as it completes instead of being skipped.

### 68. ✅ Unexpected fields in a profile update cause a server error (#59)
Sending a field the profile doesn't have gives a server error instead of a
clear "bad request". Not a security hole, just sloppy.
**Fixed:** unknown fields get a clear "bad request".

### 69. ✅ Refunded payments crashed the payment page (#63)
The dashboard's money formatter refused negative numbers, but refunds appear as
negative amounts in the payment timeline, so the page crashed. The
reconciliation page crashed the same way for a negative gap.
**Fixed:** negative amounts are shown normally.

### 70. ✅ The transaction list's date filter used the wrong day (#64)
Picking a date showed payments from 3 a.m. that day to 3 a.m. the next
(UK/UTC time), not the Bahrain day. A comment claimed it had been fixed.
**Fixed:** it now uses the Bahrain day.

### 71. ✅ The transactions report used the wrong day boundaries (#65)
The report compares dates the same UTC way; whether that's wrong depends on
what the caller sends.
**Fixed:** a day in the report now starts at midnight Bahrain time, not 3 a.m. Tested with a payment made at 1 a.m. on 1 March.

### 72. ➖ The reporting service may leak database connections (#30)
**Not a bug:** it opens exactly one connection for listening and closes it when it stops.

### 73. ➖ Two fee rows with the same start date aren't prevented (#31)
**Not a bug any more:** since #44 was fixed, both parts of the system pick the same row (the newest one) when two rows share a start date.

### 74. ✅ One missing number crashed the reports worker, so refunds never reached the reports (#75)
When a shop's day is closed, the reports worker double-checks that it has
counted that day's payments. If it had *no* record for that day at all
(the very situation the check is meant to warn about), it crashed instead of
warning, and every update queued behind it got stuck, refunds included. A
code comment even claims a test covers this case; it doesn't.
**Fixed:** a missing record now counts as zero and produces a warning. Tested;
after restarting the worker, the stuck updates went through and the refund
showed up in the reports.

---

## The unfinished feature (ticket FP-300): refunds

The last developer started **refunds** (giving a customer their money back)
and never finished. **Status: built and working end to end, except hosting.**

- **Asking for a refund:** shops can now refund a payment through the API and
  from a button on the payment page.
- **Money is right to the fils:** we fixed refunding more than was charged (#46),
  two refunds at once (#50), refunding another shop's payment (#51) and fee
  rounding on partial refunds (#5). In a live test, refunding 4 BD of a 10 BD
  payment gave back 90 fils of the 225 fils fee, exactly 40%.
- **Payouts:** the daily payout now subtracts refunds. (If a day's refunds are
  bigger than its sales, that day pays nothing and the difference isn't carried
  over yet; the ledger still shows the right balance.)
- **Shops are told:** the "refund succeeded" notification is sent; we received
  it on a test endpoint.
- **Timeline, reports and reconciliation** all show the refund; reconciliation
  matched to the fils.
- **Hosting on "Dilmune Cloud":** not started yet. We need the details from the
  organisers.

---

## What we learned along the way

- **Several "rules" files in the repo can't be trusted.** CLAUDE.md,
  AGENTS.md, .cursorrules and the CHANGELOG say things that aren't true (for
  example "1 BD = 100 fils", "never change a test", and fixes that never
  happened). The architecture document and design records are the real rules.
- **Many bugs were explained away rather than fixed.** Comments like "Claude
  says it's fine" or "this is intentional" usually sit right on top of a real
  bug.
- **The support ticket sheet (29 Oct 2026)** is matched to bug numbers at the bottom of [BUGS.md](BUGS.md).
- **The finance memo of 20 Sept 2026** lists 12 problems; each one is matched
  to a bug number in [BUGS.md](BUGS.md).
- **Test data:** running the automated tests adds hundreds of fake shops to the
  local database. `npm run seed` resets it.

## Follow-up after Zahra's push

- **#34 / #76 — Callback security:** the API now checks the exact message bytes the sender signed. It rejects invalid callback fields and cannot turn callback authentication off in production.
- **#48 — Expired payment links:** the server clock decides expiry. A customer cannot extend a link by claiming they pressed pay earlier.
- **#77 — Spreadsheet exports:** customer references starting with formula characters stay text when opened in a spreadsheet. Both export paths share the correction.
- **#78 — Payout instructions:** repeated or concurrent webhook attempts use the same batch lock and do not create a second instruction. Existing records are preserved.
- **#79 — Webhook responses:** redirects are not followed. The API retains at most 64 KiB from a receiver and stops reading afterward.
- **#80 — Uncertain payments:** a timeout does not mean no payment happened. The link stays processing until the attempt is reconciled; another buyer cannot take it over just because time passed. Explicit declines can release the reservation.

These additions retain Zahra's existing report access, credit approval, key
rotation overlap, outbound signing, streaming export and atomic capture fixes.
See docs/reviews/2026-10-30-post-zahra-gaps.md for checks and remaining limits.

## Backend reliability — 30 October 2026

### 75. ✅ A brand-new database couldn't be set up (#81)

Setting up FilsPay on a new server means running the database setup steps
(`npm run migrate`) on an empty database. Step 54 failed because it referred to
a table that never existed. Once that was fixed, step 55 failed because it used
column names the table doesn't have. Our own computers only worked because they
were set up with different versions of those two steps. So no new server could
be set up, including the Dilmune hosting. Both steps now match what our working
database actually has, and a completely empty database sets up from start to
finish.
