using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;

namespace OpenAcom.Desktop
{
    internal sealed class MachineProfile
    {
        public string Title {get;set;} public Dictionary<string,object> Values {get;set;}
    }
    internal sealed partial class ModernShell
    {
        private StackPanel fleetBody;
        private Config fleetConnection;
        private Dictionary<string,object> fleetSnapshot;
        private string fleetMode="overview",fleetNodeFilter="",fleetStatusFilter="";
        private bool fleetBusy,remoteBusy;
        private TextBox fleetOutput;
        private readonly Dictionary<string,string> sshProfile=new Dictionary<string,string>{{"host",""},{"user",""},{"sshPort","22"},{"identity",""},{"port","19330"},{"remotePort","9330"},{"remoteHost","127.0.0.1"},{"nodeId","remote-node"},{"remoteUrl","http://127.0.0.1:9330"}};
        private System.Windows.Forms.NotifyIcon inboxTray;
        private long watchedCount;
        private string latestInboxId;
        private List<string> inspectedKeys=new List<string>();
        private string inspectedHost;
        private void InitializeFleet()
        {
            fleetBody=Find<StackPanel>("FleetBody");
            Find<Button>("NavFleet").Click+=delegate{Navigate("Fleet");ShowFleetOverview();};
            Find<Button>("NavWatch").Click+=delegate{Navigate("Watch");};
            Find<Button>("FleetOverviewButton").Click+=delegate{ShowFleetOverview();};
            Find<Button>("FleetSshButton").Click+=delegate{ShowSshPanel(false);};
            Find<Button>("FleetRemoteButton").Click+=delegate{ShowSshPanel(true);};
            Find<Button>("WatchStart").Click+=async delegate{Find<Button>("WatchStart").IsEnabled=false;try{int seconds;if(!int.TryParse(Find<TextBox>("WatchInterval").Text,out seconds)||seconds<1||seconds>60)throw new Exception("监听间隔必须为 1–60 秒");await StartService("inbox","0","","",new Dictionary<string,object>{{"receiver",Find<TextBox>("WatchReceiver").Text.Trim()},{"pollMs",seconds*1000},{"includeExisting",Find<CheckBox>("WatchExisting").IsChecked==true}});}catch(Exception e){DesktopService active;WatchServiceState(services.TryGetValue("inbox",out active)&&!active.Process.HasExited?"running":"failed");Status(e.Message);}};
            Find<Button>("WatchStop").Click+=async delegate{try{await StopService("inbox");WatchServiceState("stopped");}catch(Exception e){Status(e.Message);}};
            Find<Button>("WatchOpen").Click+=async delegate{await OpenInboxNotice();};
            window.Closed+=delegate{if(inboxTray!=null){inboxTray.Visible=false;inboxTray.Dispose();}};
        }
        private void FleetHeading(string title,string detail)
        {
            fleetBody.Children.Clear();fleetBody.Children.Add(Label(title,20,"#E3E9F4"));var text=Label(detail,12,"#99A8BC");text.TextWrapping=TextWrapping.Wrap;text.Margin=new Thickness(0,10,0,18);fleetBody.Children.Add(text);fleetOutput=null;
        }
        private TextBox FleetField(string label,string key)
        {fleetBody.Children.Add(Label(label,12,"#B5C3D5"));var field=new TextBox{Text=sshProfile[key],Margin=new Thickness(0,6,0,12)};field.TextChanged+=delegate{sshProfile[key]=field.Text;};fleetBody.Children.Add(field);return field;}
        private void FleetAction(string name,Func<Task> action)
        {
            var button=ControlButton(name);button.Margin=new Thickness(0,5,0,9);button.HorizontalAlignment=HorizontalAlignment.Left;
            button.Click+=async delegate{button.IsEnabled=false;try{await action();}catch(Exception e){FleetResult(Redact.Scrub(e.Message));}finally{if(!closed)button.IsEnabled=true;}};fleetBody.Children.Add(button);
        }
        private void FleetResult(string text)
        {if(closed)return;if(fleetOutput==null){fleetOutput=new TextBox{IsReadOnly=true,TextWrapping=TextWrapping.Wrap,AcceptsReturn=true,MinHeight=70,MaxHeight=220,VerticalScrollBarVisibility=ScrollBarVisibility.Auto,Margin=new Thickness(0,14,0,0)};fleetBody.Children.Add(fleetOutput);}fleetOutput.Text=Redact.Scrub(text);Status("分布式控制："+Redact.Scrub(text.Split('\n')[0]));}
        private Dictionary<string,object> FleetRequest(string action)
        {
            var cfg=fleetConnection??Config.Discover(new Options{Url=Find<TextBox>("HubUrl").Text.Trim(),Token=Find<PasswordBox>("HubToken").Password});
            Redact.SetSecret(cfg.Token);return new Dictionary<string,object>{{"action",action},{"url",cfg.Url},{"token",cfg.Token}};
        }
        private async Task RefreshFleet()
        {
            if(fleetBusy)return;fleetBusy=true;
            try {
                var cfg=Config.Discover(new Options{Url=Find<TextBox>("HubUrl").Text.Trim(),Token=Find<PasswordBox>("HubToken").Password});Redact.SetSecret(cfg.Token);
                var req=new Dictionary<string,object>{{"action","fleet.snapshot"},{"url",cfg.Url},{"token",cfg.Token},{"node",fleetNodeFilter},{"status",fleetStatusFilter}};
                var data=await Execute(req);if(closed)return;fleetConnection=cfg;fleetSnapshot=data;if(fleetMode=="overview")ShowFleetOverview();
            }catch(Exception e){FleetResult("无法读取 Hub："+Redact.Scrub(e.Message));}finally{fleetBusy=false;}
        }
        private void ShowFleetOverview()
        {
            fleetMode="overview";FleetHeading("节点与远端消息","这里读取 Hub 的全局队列，不会领取消息或改变投递状态。远端节点需要先部署并注册。");
            FleetAction("连接 / 刷新 Hub",async delegate{await RefreshFleet();});
            FleetAction("配置连接与令牌",delegate{Navigate("Settings");return Task.FromResult(0);});
            if(fleetSnapshot==null){FleetResult("请在连接设置填写 Hub 地址与令牌，再点击连接 / 刷新。远端 Hub 可先通过 SSH 通道映射到本机。");return;}
            var nodes=J.A(fleetSnapshot,"nodes")??new List<object>();var queue=J.A(fleetSnapshot,"messages")??new List<object>();
            var summary=new Border{Background=Ink("#232A38"),CornerRadius=new CornerRadius(12),Padding=new Thickness(20),Margin=new Thickness(0,14,0,20)};
            summary.Child=Label(nodes.Count+" 个节点    ·    "+nodes.Count(n=>J.B(J.AsObject(n),"online"))+" 在线    ·    "+J.N(fleetSnapshot,"total")+" 条队列记录",17,"#B6CCD9");fleetBody.Children.Add(summary);
            var cards=new WrapPanel();fleetBody.Children.Add(cards);
            foreach(var value in nodes){var nodeRow=J.AsObject(value);string id=J.S(nodeRow,"id");bool online=J.B(nodeRow,"online");var targets=(J.A(nodeRow,"targets")??new List<object>()).Select(Convert.ToString).ToList();
                var panel=new StackPanel();panel.Children.Add(Label((online?"●  ":"○  ")+id,17,online?"#91D1B8":"#9AA6B9"));var info=Label((online?"心跳在线":"心跳离线")+" · "+targets.Count+" 个目标\n最后心跳 "+J.Stamp(J.N(nodeRow,"lastSeen")),11,"#899AB0");info.Margin=new Thickness(0,10,0,12);info.TextWrapping=TextWrapping.Wrap;panel.Children.Add(info);
                var targetBox=new ComboBox{ItemsSource=targets,SelectedIndex=targets.Count>0?0:-1,Height=34};panel.Children.Add(targetBox);
                var send=ControlButton("向此目标发消息 ↗");send.IsEnabled=targets.Count>0;send.Margin=new Thickness(0,12,0,8);send.Click+=delegate {if(fleetConnection==null)return;remote=fleetConnection;generation++;SetConnection();OpenCompose();Find<TextBox>("Recipient").Text="node:"+id+"/"+Convert.ToString(targetBox.SelectedItem);SelectRoute("relay");};panel.Children.Add(send);
                var manage=ControlButton("管理该节点的远端进程");manage.Click+=delegate{sshProfile["nodeId"]=id;sshProfile["host"]="";ShowSshPanel(true);};panel.Children.Add(manage);
                cards.Children.Add(new Border{Width=280,Background=Ink("#1D2430"),CornerRadius=new CornerRadius(12),BorderBrush=Ink(online?"#35534D":"#333C4B"),BorderThickness=new Thickness(1),Padding=new Thickness(18),Margin=new Thickness(0,0,12,12),Child=panel});
            }
            var filter=new StackPanel{Orientation=Orientation.Horizontal,Margin=new Thickness(0,15,0,15)};var nodeFilter=new ComboBox{Width=210,Height=34,ItemsSource=new[]{"全部节点"}.Concat(nodes.Select(n=>J.S(J.AsObject(n),"id"))).ToList(),SelectedItem=string.IsNullOrEmpty(fleetNodeFilter)?"全部节点":fleetNodeFilter};
            var statusFilter=new ComboBox{Width=180,Height=34,Margin=new Thickness(10,0,10,0),ItemsSource=new[]{"全部状态","queued","delivering","delivered","deferred","uncertain","failed","expired"},SelectedItem=string.IsNullOrEmpty(fleetStatusFilter)?"全部状态":fleetStatusFilter};
            var apply=ControlButton("筛选队列");apply.Click+=async delegate{fleetNodeFilter=Convert.ToString(nodeFilter.SelectedItem);if(fleetNodeFilter=="全部节点")fleetNodeFilter="";fleetStatusFilter=Convert.ToString(statusFilter.SelectedItem);if(fleetStatusFilter=="全部状态")fleetStatusFilter="";await RefreshFleet();};filter.Children.Add(nodeFilter);filter.Children.Add(statusFilter);filter.Children.Add(apply);fleetBody.Children.Add(filter);
            if(!string.IsNullOrEmpty(J.S(fleetSnapshot,"warning")))fleetBody.Children.Add(Label(J.S(fleetSnapshot,"warning"),12,"#D7B381"));
            foreach(var value in queue){var row=J.AsObject(value);string id=J.S(row,"id");var panel=new StackPanel();panel.Children.Add(Label(J.S(row,"to")+" / "+J.S(row,"target")+"    ·    "+State(J.S(row,"status")),14,"#D7E2EF"));var preview=Label(J.S(row,"text"),12,"#98A6B9");preview.Margin=new Thickness(0,10,0,12);panel.Children.Add(preview);
                var buttons=new StackPanel{Orientation=Orientation.Horizontal};var detail=ControlButton("投递详情");detail.Click+=async delegate{try{var req=FleetRequest("fleet.message");req["id"]=id;var result=await Execute(req);ShowDocument("远端消息 · "+id,"状态："+J.S(result,"status")+"\n目标："+J.S(result,"to")+" / "+J.S(result,"target")+"\n尝试："+J.N(result,"attempts")+"  重排队："+J.N(result,"retries")+"\n\n"+J.S(result,"text")+"\n\n"+Json.Write(J.O(result,"error")));}catch(Exception e){FleetResult(e.Message);}};buttons.Children.Add(detail);
                var retry=ControlButton("重新排队");retry.IsEnabled=J.B(row,"retryEligible");retry.Click+=async delegate{if(MessageBox.Show(window,"重新排队此消息？Hub 会重新检查投递状态。", "远端投递",MessageBoxButton.YesNo,MessageBoxImage.Question)!=MessageBoxResult.Yes)return;try{var req=FleetRequest("fleet.retry");req["id"]=id;await Execute(req);await RefreshFleet();}catch(Exception e){FleetResult(e.Message);}};buttons.Children.Add(retry);panel.Children.Add(buttons);fleetBody.Children.Add(new Border{Background=Ink("#1B212C"),CornerRadius=new CornerRadius(10),Padding=new Thickness(16),Margin=new Thickness(0,0,0,10),Child=panel});
            }
            FleetAction("查看安全事件",delegate{ShowDocument("Hub 安全事件",Json.Write(J.A(fleetSnapshot,"alerts")));return Task.FromResult(0);});
            FleetAction("清理留存期外的历史",async delegate{if(MessageBox.Show(window,"按 Hub 现有留存策略清理历史记录？", "清理历史",MessageBoxButton.YesNo)!=MessageBoxResult.Yes)return;var result=await Execute(FleetRequest("fleet.prune"));await RefreshFleet();FleetResult("清理完成："+Json.Write(result));});
            FleetAction("管理本机 Hub / 节点服务",async delegate{Navigate("Controls");await BuildControlPanel("服务管理");});
        }
        private Dictionary<string,object> RemoteRequest(string operation)
        {
            var req=sshProfile.ToDictionary(pair=>pair.Key,pair=>(object)pair.Value);req["action"]="remote.execute";req["operation"]=operation;req["token"]=Find<PasswordBox>("HubToken").Password;Redact.SetSecret(Convert.ToString(req["token"]));return req;
        }
        private async Task RemoteAction(string operation,Dictionary<string,object> extra=null)
        {
            if(remoteBusy)throw new Exception("另一个远端操作正在执行");remoteBusy=true;
            try {var req=RemoteRequest(operation);if(extra!=null)foreach(var pair in extra)req[pair.Key]=pair.Value;FleetResult("正在执行远端操作："+operation+" …");var result=await Execute(req);FleetResult(J.Has(result,"text")?J.S(result,"text"):Json.Write(result));}
            finally{remoteBusy=false;}
        }
        private void ShowSshPanel(bool remoteControl)
        {
            fleetMode=remoteControl?"remote":"ssh";
            FleetHeading(remoteControl?"远端节点部署与生命周期":"SSH 通道",remoteControl?"使用 SSH 在所选机器的用户目录部署独立节点。远端需有 Node.js 22.5+；部署不启动，启动后通过身份验证端口停止，不按猜测的 PID 杀进程。远端节点不会随本机窗口退出而停止。":"映射远端 Hub 到本机回环端口。使用已有 SSH 私钥或 agent，先检查并确认主机指纹。");
            var body=fleetBody;var connectionFields=new StackPanel();var connectionExpander=new Expander{Header="SSH 连接信息与已保存机器",IsExpanded=string.IsNullOrEmpty(sshProfile["host"]),Foreground=Ink("#BFCADF"),Content=connectionFields,Margin=new Thickness(0,0,0,16)};body.Children.Add(connectionExpander);fleetBody=connectionFields;
            var profiles=new ComboBox{DisplayMemberPath="Title",MinHeight=34,Margin=new Thickness(0,0,0,12)};fleetBody.Children.Add(profiles);
            FleetAction("加载已保存的机器",async delegate{var result=await Execute(new Dictionary<string,object>{{"action","fleet.profiles.get"}});profiles.ItemsSource=(J.A(result,"profiles")??new List<object>()).Select(p=>{var values=J.AsObject(p);return new MachineProfile{Title=J.S(values,"host")+" · "+J.S(values,"nodeId"),Values=values};}).ToList();FleetResult("请从上方列表选择机器。");});
            profiles.SelectionChanged+=delegate{var selected=profiles.SelectedItem as MachineProfile;if(selected==null)return;foreach(var key in sshProfile.Keys.ToList())if(J.Has(selected.Values,key))sshProfile[key]=J.S(selected.Values,key);ShowSshPanel(remoteControl);};
            FleetAction("保存当前机器配置",async delegate{await Execute(new Dictionary<string,object>{{"action","fleet.profiles.save"},{"profile",sshProfile.ToDictionary(p=>p.Key,p=>(object)p.Value)}});FleetResult("机器配置已保存；不会保存私钥内容或 Hub 令牌。");});
            FleetField("SSH 主机 / IP","host");FleetField("SSH 用户","user");FleetField("SSH 端口","sshPort");var identity=FleetField("私钥文件（可留空，使用 SSH agent）","identity");
            FleetAction("选择 SSH 私钥",delegate{var dialog=new Microsoft.Win32.OpenFileDialog();if(dialog.ShowDialog(window)==true)identity.Text=dialog.FileName;return Task.FromResult(0);});
            FleetAction("检查主机指纹",async delegate{var req=RemoteRequest("probe");req["action"]="ssh.scan";var result=await Execute(req);inspectedKeys=(J.A(result,"keys")??new List<object>()).Select(k=>J.S(J.AsObject(k),"fingerprint")).ToList();inspectedHost=sshProfile["host"]+":"+sshProfile["sshPort"];FleetResult(inspectedHost+"\n"+string.Join("\n",inspectedKeys)+"\n请与机器管理员或可信记录核对，再确认信任。");});
            FleetAction("信任已核对的主机指纹",async delegate{if(inspectedKeys.Count==0||inspectedHost!=sshProfile["host"]+":"+sshProfile["sshPort"])throw new Exception("请先检查当前主机指纹");if(MessageBox.Show(window,"确认信任以下主机指纹？\n"+inspectedHost+"\n"+string.Join("\n",inspectedKeys),"SSH 主机身份",MessageBoxButton.YesNo,MessageBoxImage.Question)!=MessageBoxResult.Yes)return;var req=RemoteRequest("probe");req["action"]="ssh.trust";req["fingerprints"]=inspectedKeys.Cast<object>().ToList();await Execute(req);FleetResult("指纹已保存，SSH 将严格核对该主机。");});
            fleetBody=body;
            if(!remoteControl){
                FleetField("本机映射端口","port");FleetField("远端 Hub 主机（从 SSH 机器访问）","remoteHost");FleetField("远端 Hub 端口","remotePort");
                FleetAction("启动 SSH 通道",async delegate{await StartService("ssh",sshProfile["port"],"","",sshProfile.ToDictionary(p=>p.Key,p=>(object)p.Value));Find<TextBox>("HubUrl").Text="http://127.0.0.1:"+sshProfile["port"];FleetResult("SSH 进程启动中。请在连接设置测试 Hub；通道断开信息可在服务日志查看。");});
                FleetAction("停止 SSH 通道",async delegate{await StopService("ssh");FleetResult("已请求停止本窗口的 SSH 通道。");});
                FleetAction("查看通道日志",delegate{DesktopService service;FleetResult(services.TryGetValue("ssh",out service)?service.State+"\n"+service.Log:"尚未启动 SSH 通道");return Task.FromResult(0);});return;
            }
            FleetField("远端节点 ID（每台机器唯一）","nodeId");FleetField("远端机器访问的 Hub URL","remoteUrl");
            FleetAction("1 · 检测远端运行环境",async delegate{await RemoteAction("probe");});
            FleetAction("2 · 部署 / 更新 OpenAcom 节点",async delegate{await RemoteAction("install");});
            FleetAction("查看已配置目标与终端描述文件",async delegate{await RemoteAction("targets.get");});
            var name=new TextBox{Text="agent",Margin=new Thickness(0,6,0,12)};fleetBody.Children.Add(Label("远端目标名称",12,"#B5C3D5"));fleetBody.Children.Add(name);
            var type=new ComboBox{ItemsSource=new[]{"zcode","terminal"},SelectedIndex=0,Height=34,Margin=new Thickness(0,6,0,12)};fleetBody.Children.Add(Label("目标类型",12,"#B5C3D5"));fleetBody.Children.Add(type);
            var value=new TextBox{Margin=new Thickness(0,6,0,12)};fleetBody.Children.Add(Label("ZCode session ID / 远端终端描述文件名",12,"#B5C3D5"));fleetBody.Children.Add(value);
            var port=new TextBox{Text="9222",Margin=new Thickness(0,6,0,12)};fleetBody.Children.Add(Label("远端 ZCode CDP 端口",12,"#B5C3D5"));fleetBody.Children.Add(port);
            FleetAction("3 · 保存远端目标",async delegate{await RemoteAction("target.save",new Dictionary<string,object>{{"name",name.Text},{"type",type.SelectedItem},{"value",value.Text},{"cdpPort",port.Text}});});
            FleetAction("移除指定远端目标",async delegate{if(MessageBox.Show(window,"移除此节点的目标 "+name.Text+"？重启节点后生效。","移除目标",MessageBoxButton.YesNo)!=MessageBoxResult.Yes)return;await RemoteAction("target.remove",new Dictionary<string,object>{{"name",name.Text}});});
            FleetAction("4 · 启动远端节点",async delegate{await RemoteAction("start");});
            FleetAction("查询远端进程状态",async delegate{await RemoteAction("status");});
            FleetAction("停止远端节点",async delegate{await RemoteAction("stop");});
            FleetAction("重启远端节点",async delegate{if(remoteBusy)throw new Exception("请等待当前操作完成");remoteBusy=true;try{var req=RemoteRequest("stop");var stopped=await Execute(req);if(J.S(stopped,"state")!="stopped")throw new Exception("节点尚未停止，请稍后查询状态");req["operation"]="start";FleetResult(Json.Write(await Execute(req)));}finally{remoteBusy=false;}});
            FleetAction("查看远端节点日志",async delegate{await RemoteAction("logs");});
        }
        private void WatchServiceState(string state)
        {
            if(closed)return;
            bool running=state=="running";Find<TextBlock>("WatchState").Text=running?"●  正在后台监听":state=="failed"?"监听启动失败，请查看状态信息":"○  已停止监听";Find<Button>("WatchStart").IsEnabled=!running;Find<Button>("WatchStop").IsEnabled=running;
            if(running&&inboxTray==null&&!options.UiSmoke){inboxTray=new System.Windows.Forms.NotifyIcon{Icon=System.Drawing.SystemIcons.Information,Text="OpenAcom 收件箱监听"};inboxTray.BalloonTipClicked+=delegate{if(!closed)window.Dispatcher.BeginInvoke(new Action(async ()=>{window.Show();window.WindowState=WindowState.Normal;window.Activate();await OpenInboxNotice();}));};inboxTray.DoubleClick+=delegate{window.Dispatcher.BeginInvoke(new Action(()=>{window.Show();window.WindowState=WindowState.Normal;window.Activate();Navigate("Watch");}));};}
            if(inboxTray!=null)inboxTray.Visible=running;
        }
        private async void InboxArrived(Dictionary<string,object> notice)
        {
            if(closed)return;
            long count=J.N(notice,"count");watchedCount+=count;var rows=J.A(notice,"messages")??new List<object>();var last=rows.Count==0?null:J.AsObject(rows[rows.Count-1]);latestInboxId=J.S(last,"id");
            Find<TextBlock>("WatchCount").Text="已提示 "+watchedCount+" 条新消息";Find<TextBlock>("WatchLast").Text=last==null?"":J.S(last,"from")+" → "+J.S(last,"to")+"\n"+DateTime.Now.ToString("HH:mm:ss");
            if(Find<CheckBox>("WatchNotify").IsChecked==true&&inboxTray!=null&&!options.UiSmoke)inboxTray.ShowBalloonTip(4000,"OpenAcom · 新消息",count+" 条新消息进入收件箱，双击托盘图标查看。",System.Windows.Forms.ToolTipIcon.Info);
            if(!closed&&!options.UiSmoke)await Refresh();
        }
        private async Task OpenInboxNotice(){await Refresh();Navigate("Messages");Find<TextBox>("SearchBox").Clear();var found=messages.FirstOrDefault(m=>m.Id==latestInboxId);if(found!=null){Find<ListBox>("MessagesList").SelectedItem=found;Find<ListBox>("MessagesList").ScrollIntoView(found);}}
    }
}

