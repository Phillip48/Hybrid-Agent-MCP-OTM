# PM2 Command Reference

## Start / Run

pm2 start index.js --name otm-agent
pm2 start index.js --name otm-agent -- "Show me all available territories"
pm2 start index.js --name otm-agent --watch
pm2 start ecosystem.config.js

## Stop / Restart / Delete

pm2 stop otm-agent
pm2 restart otm-agent
pm2 reload otm-agent          # zero-downtime reload
pm2 delete otm-agent
pm2 stop all
pm2 restart all
pm2 delete all

## Status & Monitoring

pm2 list                      # show all processes
pm2 status                    # alias for list
pm2 show otm-agent            # detailed info for one process
pm2 monit                     # live CPU/memory dashboard

## Logs

pm2 logs                      # stream all logs
pm2 logs otm-agent            # stream logs for one process
pm2 logs otm-agent --lines 50 # last N lines
pm2 flush                     # clear all log files
pm2 reloadLogs                # reopen log files (after rotation)

## Startup (survive reboots)

pm2 startup                   # generate and print startup script command
pm2 save                      # freeze current process list
pm2 unstartup                 # remove startup hook

## Environment

pm2 start index.js --name otm-agent --env production
pm2 restart otm-agent --update-env

## Misc

pm2 info otm-agent            # alias for show
pm2 reset otm-agent           # reset restart counter and uptime
pm2 ping                      # check if PM2 daemon is alive
pm2 kill                      # kill PM2 daemon and all processes
pm2 update                    # update PM2 in-place
