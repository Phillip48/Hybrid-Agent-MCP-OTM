/**
 * otm-knowledge.js
 *
 * Comprehensive OTM (Online Territory Manager) knowledge base.
 * Sources: OTM Help page, actual page source, live session logs, OTM user guide.
 * Imported by bot.js to build the AI system prompt.
 */

export const OTM_KNOWLEDGE = `
## OTM (Online Territory Manager) — Complete Knowledge Base

### What is OTM?
OTM is a web-based territory management system for Jehovah's Witness congregations.
It runs at https://onlineterritorymanager.com. There is no app to download — everything
is done through the browser. A mobile version exists at mobile.onlineterritorymanager.com.
Each congregation has its own account. Users log in with a username and password assigned
by the territory servant (admin).

### User Roles
- **Territory Servant / Admin**: Full access — can check out territories to any publisher,
  return territories, manage users, run reports, edit addresses.
- **Publisher (regular user)**: Can check out territories to themselves, view their own
  territory folder, and use OTM Mobile to work territory and record visits.

---

## Site Map — Every Page and Its Purpose

### Main Navigation
| Page | URL | Purpose |
|------|-----|---------|
| Home / Welcome | welcome.php | Dashboard after login |
| Standard Checkout | GetStandard.php | List and check out standard territories |
| Custom Checkout | MakeCustom.php | Build a custom territory by filtering addresses (street, city, etc.) |
| My Territory Folder | MyTer.php?showallmyter=0 | View your own checked-out territories; print maps |
| Checked Out Admin | MyTer.php?showallmyter=1&sort=1 | Admin view of ALL checked-out territories |
| Log Out | logout.php | End session |

### Reports (Tools → Reports)
| Report | URL | What it shows |
|--------|-----|--------------|
| Address Density Map | BigMap.php | Map showing address density across territories |
| Standard Territory Maps | StandTerMapAll.php | Printable maps for all standard territories |
| Territory Map Worked Status | StandTerMapWorked.php | Map color-coded by worked status |
| Territory Worked Log | TerrWrkLog.php | When each territory was last worked and checked in/out |
| Letter Writing Stats | LetterWritingStats.php | Stats for letter writing campaigns |
| Check In/Out S-13 v1 | TerrWrkLogRptV1.php | Official S-13 format report (version 1) |
| Check In/Out S-13 v2 | TerrWrkLogRptV2.php | Official S-13 format report (version 2, most common) |
| Check In/Out S-13 v3 | TerrWrkLogRptV3_Blank.php | Blank S-13 template |
| Check In/Out Old | TerrWrkLogRpt.php | Legacy check in/out sheets |
| Territory List | TerrListRpt.php | Printable full territory list |
| Territory List Export | TerListExp.php | Exportable territory data |
| Address List Export w/RV | Backup.php?what=L | Address list including return visits |
| Stats By Groupings | RptStatsByGrouping.php | Territory statistics by grouping/type |
| Address Demographics | RptStatsAddrDemo.php | Breakdown of address types |
| Group Statistics | GroupStats.php | Statistics per service group |

### Address Tools (Tools → Address Tools)
| Tool | URL | Purpose |
|------|-----|---------|
| Search/Edit/Delete | AddrSearch.php | Find and modify individual addresses |
| Address Entry | AdminSingleAddr.php | Add a single new address |
| Bulk Address Import | AddrImportAdmin.php | Import addresses from CSV file |
| Geocoding | GeoHere.php | Set latitude/longitude for addresses |
| Bulk Geocoding | jwgeomysql.php | Geocode many addresses at once |
| Duplicate Checker | DupChecker.php | Find and remove duplicate addresses |
| Foreign Language Export | ForeignLangExpAdmin.php | Export addresses for foreign language territory |

### Territory Tools (Tools → Territory Tools)
| Tool | URL | Purpose |
|------|-----|---------|
| Territory Borders | StandTerAdmin/ | Draw/edit territory map boundaries |
| Multi Delete | DeleteTerritories.php | Delete multiple territories at once |
| Campaigns | CampaignAdmin.php | Manage special campaigns |
| Groupings | TerGroupAdmin.php | Create/manage territory groupings |
| Route Setup | TerRoute.php | Set up territory routes |
| Auto Assign Admin | AutoAssignAdmin.php | Automatically assign addresses to territories |
| Territory Types | TerTypeAdmin.php | Manage territory types (residential, business, etc.) |
| Manual Assign | TerrSplitAdmin.php | Manually assign addresses to territories |
| Export to KML | exportKML.php | Export territory borders as KML for Google Maps |
| Import KML | KMLImportAdmin.php | Import KML boundary data |
| Import Worked Log | ImportTerLogAdmin.php | Import territory worked history |
| Zip Code KML | ZipCodes.php | Download zip code boundary KML files |

### Admin Tools (Tools → Admin Tools)
| Tool | URL | Purpose |
|------|-----|---------|
| Import Users | UserImportAdmin.php | Bulk import user accounts |
| Backups | BackupAdmin.php | Create database backups |
| Restore Address Backup | RestoreBackupAdmin.php | Restore address data from backup |
| Restore Territory Backup | RestoreBackupTer.php | Restore territory data from backup |
| Announcements | AnnounceAdmin.php | Post announcements to users |
| Send Email | SendEmail.php | Send emails to users |
| Users | Users.php | Manage publisher/user accounts |
| Group/Cong Options | GroupPref.php | Congregation-wide settings |
| User Preferences | UserPref.php | Individual user settings |
| Cong Territory Border | CongMapBorders.php | Set congregation territory border on map |

---

## Standard Territory Checkout — Exact Step-by-Step Flow

### Step 1: Territory List (GetStandard.php)
- Left panel shows a table of all territories.
- Columns: Territory Name/Number | Description | # Avail (available addresses) | # Addrs (total) | # Confirmed | Last Worked | Last Check In
- ORANGE color = territory not worked in 6+ months
- RED color = territory not worked in 12+ months (1 year)
- A dropdown at the top filters by grouping: "All Territories", "Show Available Only", or specific groupings.
- Clicking a territory name triggers getTerList(ID, 0, 0, 0) JavaScript — loads the right panel (#listter) via AJAX.
- Territory links have href="#" so the URL doesn't change.

### Step 2: Territory Detail Panel (#listter)
- Right panel loads after clicking a territory.
- Shows territory name, description, map preview, and a CHECK OUT button.
- Also shows number of available addresses and territory details.

### Step 3: Clicking CHECK OUT
- Panel changes to show: "Territory #XX — Description"
- "Who would you like this territory checked out to? :"
- Lists ALL publishers in the congregation, each on their own line.
- Format: "Publisher Name (X of Y checked out)" — shows how many territories they currently have.
- Each publisher has a "Yes!" link/button next to their name.
- Clicking "Yes!" next to a publisher's name checks the territory out to that specific publisher.
- OTM then shows: "Congratulations! Territory #XX has been checked out to [Publisher Name]."
- Also shows options to print the territory or view maps.

### Step 4: After Checkout
- The territory now shows as checked out to that publisher.
- Publisher can print the territory from My Territory Folder.
- Territory appears in MyTer.php for that publisher.

---

## Territory Check-In (Return) — Exact Flow

### From Checked Out Admin (MyTer.php?showallmyter=1)
- Table shows: Publisher Name | Territory# - Description | % Worked | Date Checked Out | Type | ... | Yes (return link)
- The "Yes" link in each row is the return/check-in link for that territory.
- Clicking "Yes" initiates the check-in process.
- Publisher can mark addresses as visited, update RV notes, etc. during check-in.
- Admin can check in territories on behalf of publishers.

### From My Territory Folder (MyTer.php?showallmyter=0)
- Shows only the logged-in user's territories.
- Same return/check-in flow.

---

## Custom Territory Checkout (MakeCustom.php)
- Allows checking out a custom list of addresses rather than a predefined territory.
- Filter by: street name, city, zip code, address type, etc.
- Selected addresses form a one-time custom territory.
- Use case: targeting a specific street, apartment complex, or area not covered by standard territories.

---

## My Territory Folder (MyTer.php)
- Shows territories checked out to the logged-in user.
- Options for each territory:
  - Print the territory (address list)
  - Print the map
  - Share territory with field service partners
  - Check in / return the territory
  - Work the territory via OTM Mobile
- Admin users see all publishers' territories when showallmyter=1.
- Admins can check out territories to other publishers from here.

---

## OTM Mobile
- Accessed at mobile.onlineterritorymanager.com
- Designed for phone use while working territory in the field.
- Features:
  - View territory addresses on a map or list
  - Mark each address with a color code:
    - RED = not yet contacted
    - BLUE = contact attempted, not home
    - GREEN = successfully contacted
    - YELLOW = does not speak English / foreign language
  - DNC (Do Not Call) option — marks address to not return
  - Notes section — record what happened on a call, date, scriptures left
  - Work It button — start working a territory
  - Share It button — share territory access with field service partners
  - Go To Mobile Version button — switch to simplified mobile view
  - Territory button — view list of assigned/shared territories
  - Update Information button (long blue button) — saves all address updates
  - Letter writing tracking — record date a letter was written
  - Mark as Moved — verify with melissa.com and mark address as moved

---

## Territory Color Coding (GetStandard.php list)
- Black dates = worked within 6 months (normal)
- ORANGE background date = not worked in 6+ months (needs attention)
- RED background date = not worked in 12+ months (urgent — 1 year)
- The # Avail column shows how many addresses are available (not DNC, not moved)

---

## Address Color Coding (OTM Mobile)
- RED = householder not yet contacted
- BLUE = contact attempted but not spoken to (not at home)
- GREEN = successfully contacted (move on)
- YELLOW = does not speak English (foreign language)

---

## Territory Groupings
- Territories can be organized into groupings (e.g., by area, language, type).
- Filter by grouping using GetStandard.php?code=G&TerGroupID=XXXX
- Manage groupings at TerGroupAdmin.php
- "Show Available Only" uses GetStandard.php?code=B

---

## Help Topics Available (from OTM Help Page)
1. **Getting Started** — Login process and initial congregation setup
2. **Import New Addresses** — Importing from CSV, using the Add Address screen
3. **Standard Territory Borders Setup & Auto Assign** — Creating territory map boundaries, running auto-assign
4. **Business Territory Setup & Auto Assign** — Creating business territory types and boundaries
5. **Delete Addresses** — Removing addresses from the database
6. **Duplicate Checker & Geocoding** — Removing duplicates after import, setting lat/long coordinates
7. **Standard Territory Check-Out** — How to check out a territory and print it with a map
8. **KML Zip Code Boundary Import** — Using zip code KML files to create territory maps
9. **Custom Territory** — Checking out a custom territory by filtering addresses
10. **Territory Check-In** — Check-in process in detail, editing addresses during check-in
11. **My Territory Folder** — Admin options, checking out territory to another person
12. **OTM Mobile** — Using OTM on a mobile device
13. **OTM Mobile - Tracking Letter Writing** — Recording letter writing dates via mobile
14. **Edit A Checked Out Address** — Admin: editing addresses currently checked out to another user
15. **OTM User Accounts** — User roles and permission levels

---

## Publisher Management (Users.php)
- Lists all publisher accounts with their details.
- Admin can add, edit, delete, or import users.
- User roles include admin and publisher (regular user).
- Each user has a username (often their name) used for login.

---

## Tips & Common Workflows

### Finding a territory that hasn't been worked in a long time:
→ Use report_worked_log or list_territories and look for RED/ORANGE dates.

### Seeing who currently has a territory:
→ Use get_territory_status or list_checked_out.

### Checking out a territory to someone else (admin only):
→ Use checkout_territory with the publisher's name. OTM shows their name in the "Yes!" list.

### Returning a territory:
→ Use return_territory. The return link in the checked-out list says "Yes".

### Finding a publisher's exact name as stored in OTM:
→ Use list_publishers to see all names exactly as they appear in the system.

### Getting the S-13 report:
→ Use report_checkinout (version 2 is most commonly used).

### Finding all territories that are currently out:
→ Use list_checked_out. This goes to MyTer.php?showallmyter=1.
`.trim();
