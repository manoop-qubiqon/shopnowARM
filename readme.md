# ShopNow: 3-Tier E-Commerce App with One ARM Template

**Lab type:** ARM template capstone · **Level:** Intermediate · **Time:** ~90 minutes (≈15 min of that is Azure building things)
**Cost:** Fits the Azure free account. Delete the resource group the same day.

One `az deployment group create` command builds a complete, working online shop on Azure:

- **2 Linux web VMs** running a Node.js shop, behind a **Standard Load Balancer**
- **Azure SQL Database** (serverless, free offer) that stores products and orders
- **Key Vault** that holds the SQL password. The VMs read it with their **managed identity**, so no password is ever written to the VM.
- **VNet + NSG**, SSH through **Load Balancer NAT rules**, and outbound internet through an **LB outbound rule**

At the end you open the app URL from the template outputs, place an order, and watch which VM handled it.

---

## 1. Architecture

```
                        Internet
                           │
              http://shopnow-xxxxxx.<region>.cloudapp.azure.com
                           │
              ┌────────────▼─────────────┐   Public IP (Standard, static, DNS label)
              │  Standard Load Balancer  │
              │  rule-http-80  : 80 → 3000   (health probe GET /health)
              │  nat-ssh-vm1   : 50001 → vm1:22
              │  nat-ssh-vm2   : 50002 → vm2:22
              │  outbound-internet (SNAT for apt/npm/git)
              └──────┬──────────────┬────┘
   VNet 10.10.0.0/16 │              │
   snet-web 10.10.1.0/24  (NSG: allow 3000 from Internet, 22 from allowedSshSource)
              ┌──────▼─────┐  ┌─────▼──────┐
              │ vm-web-1   │  │ vm-web-2   │   Ubuntu 24.04, Standard_B1s
              │ Node app   │  │ Node app   │   system-assigned managed identity
              └──┬──────┬──┘  └──┬──────┬──┘
     get secret  │      │ SQL    │      │
   (Secrets User)│      │ (VNet service endpoint + VNet rule)
         ┌───────▼──┐  ┌▼────────▼───────────┐
         │ Key Vault│  │ Azure SQL Database  │
         │ sql-admin│  │ shopdb (serverless, │
         │ -password│  │ free offer)         │
         └──────────┘  └─────────────────────┘
```

**Request flow:** the browser hits LB port 80 → the LB picks a healthy VM → Node on port 3000 → Azure SQL. On startup each VM gets a token from the Instance Metadata Service (IMDS), reads the SQL password from Key Vault, connects to SQL, creates the tables and seeds products (only the first VM to get there does this).

---

## 2. What it costs on a free account

| Resource | SKU in template | Free-account coverage |
|---|---|---|
| 2 × VM | `Standard_B1s` | 750 h/month of B1s free for 12 months. Two VMs use it twice as fast, so delete after the lab. |
| 2 × OS disk | Premium SSD 64 GB (P6) | Matches the free managed-disk allowance (2 × P6) |
| Load Balancer | Standard | Standard LB hours and up to 5 rules are in the 12-month free services. This lab uses 1 LB rule + 2 NAT rules + 1 outbound rule. |
| Public IP | Standard, static | Small hourly charge (a few rupees a day), covered by the $200 credit |
| SQL Database | `GP_S_Gen5` serverless with `useFreeLimit: true` | Azure SQL free offer: monthly free vCore-seconds + 32 GB. **Auto-pauses** when the free amount runs out, so it never bills. |
| Key Vault | Standard, RBAC | Per-operation pricing; a lab uses a handful of operations ≈ ₹0 |
| VNet, NSG | – | Free |

> **Rule for every student:** deploy → test → take screenshots → **delete the resource group** (Section 9).

---

## 3. Prerequisites

1. **An Azure subscription**: free account or Azure for Students.
2. **Azure CLI 2.60+**, or simply use **Azure Cloud Shell (Bash)** in the portal, which has everything preinstalled. All commands in this guide are Bash. On Windows, use Cloud Shell, Git Bash or WSL.
3. **A GitHub account.** The VMs `git clone` the app from your repo, so the repo must be **public**.
4. **An SSH key pair** (Step 4.2 creates one if you don't have one).

Check your vCPU quota in the region you'll use (free trial subscriptions have a small limit):

```bash
az vm list-usage --location centralindia -o table | grep -E "Total Regional vCPUs|Standard BS Family"
```

You need **2 free vCPUs** for 2 × B1s.

---

## 4. Step-by-step

### 4.1 Put the project on GitHub

The project layout:

```
shopnow-arm-lab/
├── app/                         ← the e-commerce application (web tier)
│   ├── package.json
│   ├── server.js                ← Express API: products, orders, health, Key Vault + SQL
│   └── public/index.html        ← storefront UI (shows which VM served you)
├── infra/
│   ├── azuredeploy.json         ← THE ARM template
│   └── azuredeploy.parameters.json
├── GUIDE.md                     ← this file
└── .gitignore
```

Create a **public** repo on GitHub named `shopnow-arm-lab` (no README), then:

```bash
cd shopnow-arm-lab
git init -b main
git add .
git commit -m "ShopNow ARM template lab"
git remote add origin https://github.com/<your-github-user>/shopnow-arm-lab.git
git push -u origin main
```

> The template's `appRepoUrl` parameter points here. cloud-init on each VM runs
> `git clone --branch main <appRepoUrl> /opt/shopnow` and starts `/opt/shopnow/app/server.js`.

**(Optional) run the app locally first.** With no database settings it runs in in-memory DEMO mode:

```bash
cd app && npm install && npm start      # open http://localhost:3000
```

### 4.2 Create an SSH key (skip if you have one)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

### 4.3 Log in and create a resource group

```bash
az login                                   # not needed in Cloud Shell
az account show -o table                   # confirm the right subscription

RG=rg-shopnow-lab
LOCATION=centralindia                      # or southindia / eastus if you hit capacity errors
az group create -n $RG -l $LOCATION -o table
```

### 4.4 Fill in the parameter file

Edit `infra/azuredeploy.parameters.json` and set **`appRepoUrl`** to your repo URL.

You'll pass the rest on the command line so secrets never sit in a file:

```bash
SSH_KEY="$(cat ~/.ssh/id_ed25519.pub)"
MY_IP="$(curl -s https://api.ipify.org)/32"         # lock SSH to your IP
SQL_PASS='Shop@Now#2026-Lab'                        # 12+ chars, upper/lower/digit/symbol
ME="$(az ad signed-in-user show --query id -o tsv)" # optional: lets you view the secret in the portal
```

| Parameter | Default | What it teaches |
|---|---|---|
| `prefix` | `shopnow` | Naming convention, `minLength`/`maxLength` |
| `sshPublicKey` | *(required)* | Key-based Linux login |
| `vmCount` | `2` | `copy` loops (`minValue` 1, `maxValue` 3) |
| `vmSize` | `Standard_B1s` | `allowedValues` |
| `osDiskType` | `Premium_LRS` | `allowedValues` |
| `allowedSshSource` | `*` | NSG source filtering. **Set it to your IP.** |
| `sqlAdminLogin` | `shopadmin` | – |
| `sqlAdminPassword` | *(required)* | `securestring`: never shown in deployment history |
| `useSqlFreeOffer` | `true` | `bool` + `if()` to switch SKUs |
| `appRepoUrl` / `appRepoBranch` | *(required)* / `main` | App delivery via cloud-init |
| `adminObjectId` | `""` | `condition`: role assignment only created when set |

### 4.5 Validate, then preview with what-if

```bash
az deployment group validate -g $RG \
  --template-file infra/azuredeploy.json \
  --parameters @infra/azuredeploy.parameters.json \
  --parameters sshPublicKey="$SSH_KEY" sqlAdminPassword="$SQL_PASS" \
               allowedSshSource="$MY_IP" adminObjectId="$ME" \
  --query properties.provisioningState -o tsv
# → Succeeded

az deployment group what-if -g $RG \
  --template-file infra/azuredeploy.json \
  --parameters @infra/azuredeploy.parameters.json \
  --parameters sshPublicKey="$SSH_KEY" sqlAdminPassword="$SQL_PASS" \
               allowedSshSource="$MY_IP" adminObjectId="$ME"
```

What-if should list **16 resources to create** (with `vmCount=2`): NSG, VNet, public IP, LB, 2 NICs, SQL server, VNet rule, database, Key Vault, secret, your role assignment, 2 VMs, 2 VM role assignments. Without `adminObjectId` it's 15, because that `condition` evaluates to false.

### 4.6 Deploy: the "one click"

```bash
az deployment group create -g $RG -n shopnow-deploy \
  --template-file infra/azuredeploy.json \
  --parameters @infra/azuredeploy.parameters.json \
  --parameters sshPublicKey="$SSH_KEY" sqlAdminPassword="$SQL_PASS" \
               allowedSshSource="$MY_IP" adminObjectId="$ME" \
  -o table
```

It takes about **6–10 minutes**. Watch it in the portal: Resource group → **Deployments** → `shopnow-deploy`, and look at the order resources are created in. That order comes from `dependsOn`.

### 4.7 Read the outputs

```bash
az deployment group show -g $RG -n shopnow-deploy --query properties.outputs -o json

APP_URL=$(az deployment group show -g $RG -n shopnow-deploy --query properties.outputs.appUrl.value -o tsv)
echo $APP_URL
```

Example output:

```json
{
  "appUrl":          { "value": "http://shopnow-a1b2c3.centralindia.cloudapp.azure.com" },
  "publicIpAddress": { "value": "20.x.x.x" },
  "sshCommands":     { "value": [ "ssh -p 50001 azureuser@shopnow-a1b2c3...", "ssh -p 50002 azureuser@shopnow-a1b2c3..." ] },
  "vmNames":         { "value": [ "vm-shopnow-web-1", "vm-shopnow-web-2" ] },
  "sqlServerFqdn":   { "value": "sql-shopnow-xxxx.database.windows.net" },
  "keyVaultName":    { "value": "kv-shopnow-xxxxxxxxxxxx" }
}
```

---

## 5. Verify it works

> ⏱️ **Wait 4–6 minutes after the deployment finishes.** The deployment is "Succeeded" as soon as Azure creates the VMs, but cloud-init is still installing Node.js and cloning your repo inside them. The Key Vault role assignment can also take a few minutes to propagate. The app retries on its own.

### 5.1 Open the shop

Open `$APP_URL` in a browser. You should see:

- the **"Served by VM:"** bar showing `vm-shopnow-web-1` or `-2`
- **Database: connected** (green)
- 8 products with prices in ₹

Add items to the cart, enter a name and email, then **Place order**. The order appears under *Recent orders* along with the VM that processed it.

### 5.2 Prove the Load Balancer is balancing

A browser re-uses one TCP connection, and the LB distributes **per connection**, so the browser often sticks to one VM. `curl` opens a new connection every time:

```bash
for i in $(seq 1 10); do curl -s $APP_URL/api/info | grep -o '"vm":"[^"]*"'; done
```

You should see a mix of `vm-shopnow-web-1` and `vm-shopnow-web-2`.

### 5.3 Prove the health probe works (failover demo)

```bash
ssh -p 50001 azureuser@<fqdn-from-outputs>     # lands on vm-web-1 via NAT rule
sudo systemctl stop shopnow                    # kill the app on vm1
exit
for i in $(seq 1 10); do curl -s $APP_URL/api/info | grep -o '"vm":"[^"]*"'; done
```

Within about 10 seconds (probe every 5 s × 2 failures) **all** traffic goes to vm-web-2 and the shop keeps working. Start it again with `sudo systemctl start shopnow`.

### 5.4 Look inside a VM

```bash
ssh -p 50002 azureuser@<fqdn>
cloud-init status --long                       # should say: status: done
sudo tail -50 /var/log/cloud-init-output.log   # Node install, git clone, npm install
cat /etc/shopnow.env                           # what ARM injected (no password!)
sudo journalctl -u shopnow -n 30 --no-pager    # "Got SQL password from Key Vault ...", "Schema ready"
curl -s -H Metadata:true "http://169.254.169.254/metadata/instance/compute/name?api-version=2021-02-01&format=text"; echo
```

### 5.5 Look at the data in Azure SQL

Portal → SQL database `shopdb` → **Query editor** → log in with `shopadmin` / your password. If the portal asks, add your client IP to the server firewall.

```sql
SELECT * FROM dbo.products;
SELECT o.id, o.customer, o.total, o.served_by, o.created_at FROM dbo.orders o ORDER BY o.id DESC;
```

### 5.6 Look at the secret

Portal → Key Vault → **Secrets** → `sql-admin-password`. This only works if you passed `adminObjectId`; otherwise RBAC blocks you, which is a good discussion point. Also open **Access control (IAM)**: both VM identities have *Key Vault Secrets User*.

---

## 6. Where each ARM concept lives in the template

| Concept | Where to find it in `azuredeploy.json` |
|---|---|
| **Parameters**: types, `defaultValue`, `allowedValues`, `minValue`/`maxValue`, `minLength` | `vmSize`, `vmCount`, `prefix`, `sqlAdminPassword` |
| **`securestring`** | `sqlAdminPassword`: flows into the SQL server and the Key Vault secret, never printed |
| **Variables & functions**: `uniqueString`, `take`, `toLower`, `format`, `environment()` | `suffix`, `kvName`, `sqlServerName`, `sqlFqdn` |
| **Resource copy loop** | NICs (`nicLoop`), VMs (`vmLoop`), VM role assignments (`kvRoleLoop`) |
| **Property copy loop** | `inboundNatRules` inside the Load Balancer (one SSH NAT rule per VM) |
| **Output copy loop** | `sshCommands`, `vmNames` |
| **`condition`** | Your *Key Vault Secrets Officer* role assignment (only if `adminObjectId` is set) |
| **`if()` expression** | `dbSku` and the database `properties`: free serverless vs Basic |
| **`dependsOn`** | NIC → VNet + LB; VM → NIC + DB + VNet rule + secret; role assignment → VM |
| **`reference(..., 'full')`** | Reading each VM's managed-identity `principalId` for its role assignment |
| **Child resources** | `servers/databases`, `servers/virtualNetworkRules`, `vaults/secrets` |
| **Extension resource with `scope`** | `Microsoft.Authorization/roleAssignments` scoped to the Key Vault |
| **`resourceId()` for sub-resources** | LB frontend, backend pool, probe and NAT rule IDs |
| **`customData` + `base64()` + `format()`** | cloud-init, with SQL/Key Vault names injected into `/etc/shopnow.env` |
| **Outputs** | `appUrl`, `publicIpAddress`, `sqlServerFqdn`, `keyVaultName` |
| **Idempotency / Incremental mode** | Re-run the same deploy command: nothing changes |

---

## 7. Student tasks

Do these in order; each one shows a different ARM behaviour.

1. **Idempotency.** Run the exact same deploy command again. What changed? (Nothing. Look at the deployment duration.)
2. **Scale out with the copy loop.** Run what-if with `vmCount=3`, then deploy it. Which resources are *added*, and which are *modified*? (Hint: the LB gets a new NAT rule.) Check that a third VM name shows up in the curl loop.
   *Free trial:* 3 × B1s = 3 vCPUs; make sure your quota allows it, and scale back to 2 afterwards.
3. **Tighten security.** If you deployed with `allowedSshSource="*"`, redeploy with your `/32` IP and confirm with what-if that only the NSG rule changes.
4. **Complete mode (instructor demo).** Create a storage account by hand in the same RG, then run:
   ```bash
   az deployment group what-if -g $RG --mode Complete --template-file infra/azuredeploy.json ...
   ```
   What-if shows the storage account marked **Delete**. Discuss why Complete mode is dangerous.
5. **Break the dependency.** In a copy of the template, remove the VM's `dependsOn` entry for the Key Vault secret. Deploy into a *new* RG and read the app logs (`journalctl -u shopnow`). What does the retry loop show?
6. **Add a resource.** Add an availability set (or availability zones `["1","2"]`) for the VMs. What else has to change? (Public IP and LB are Standard SKU, so zones are supported.)
7. **Add an output.** Output the private IP of each VM using `reference()` on the NICs and a copy loop.
8. **Convert to Bicep.** Run `az bicep decompile --file infra/azuredeploy.json` and compare: lines of code, readability, how `dependsOn` disappears.

---

## 8. Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| `QuotaExceeded` / `OperationNotAllowed` on VMs | Not enough vCPUs. Use `vmCount=1` or another region; check with `az vm list-usage`. |
| `SkuNotAvailable` for Standard_B1s | Capacity in that region. Use a new RG in `southindia` or `eastus`. |
| Error mentioning the **free offer / free limit** on the SQL database | Your subscription has used its free databases, or the region lacks the offer. Redeploy with `useSqlFreeOffer=false` (Basic tier, about ₹400/month, so delete it soon). |
| `VaultAlreadyExists` / *"exists in deleted state"* | You deleted the RG earlier and recreated one with the same name, so Key Vault's soft-delete still holds the name. Run `az keyvault purge -n <kv-name>`, or use a different RG name. |
| Browser can't reach `appUrl` | cloud-init isn't finished yet; wait 5 minutes. Then SSH in and check `cloud-init status` and `/var/log/cloud-init-output.log`. |
| `git clone` fails in cloud-init log | Repo is private or the URL is wrong. Make the repo public and fix `appRepoUrl`, then on the VM run `sudo cloud-init clean --reboot`, or redeploy into a new RG. |
| Page loads but **Database: connecting**. Hover the pill to see the error. | `Key Vault read failed: 403`: role assignment still propagating; wait 2–5 min. `Login failed`: wrong password in the Key Vault secret. `Cannot open server... not allowed`: VNet rule or service endpoint missing. |
| Products take ~1 minute to load the first time | Normal. The serverless DB **auto-pauses** after 60 idle minutes and wakes on the first connection. |
| SSH `Connection refused` / timeout | Your IP changed. Redeploy with the new `allowedSshSource`, and use port **50001/50002**, not 22. |

---

## 9. Clean up (do not skip!)

```bash
az group delete -n $RG --yes --no-wait
```

The Key Vault goes into soft-delete for 7 days. To free its name right away:

```bash
az keyvault list-deleted --query "[].name" -o tsv
az keyvault purge -n <kv-name>
```

---

## 10. Explain it in an interview (one paragraph)

> "I wrote a single ARM template that deploys a 3-tier e-commerce app: a VNet with an NSG, a Standard Load Balancer with an HTTP rule, health probe, per-VM SSH NAT rules and an outbound SNAT rule, a copy loop of Linux VMs bootstrapped with cloud-init, an Azure SQL serverless database restricted to the web subnet through a service endpoint, and a Key Vault. The SQL password is a `securestring` parameter stored only in Key Vault; each VM's system-assigned managed identity gets *Key Vault Secrets User* through an RBAC role assignment, and the app reads the secret from IMDS at startup. Outputs give the public URL and SSH commands, and I validate every change with what-if before deploying."
