using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace OpenAcom.Desktop
{
    internal sealed class DesktopMessage
    {
        public string Id { get; set; }
        public string Target { get; set; }
        public string Sender { get; set; }
        public string Preview { get; set; }
        public string Status { get; set; }
        public string RouteLabel { get; set; }
        public string TimeLabel { get; set; }
        public string Detail { get; set; }
        public string State { get { return ModernShell.State(Status); } }
        public string StateBrush { get { return Status == "refused" || Status == "failed" || Status == "uncertain" ? "#D9B481" : Status == "read" || Status == "accepted" || Status == "sent" ? "#9AD3BE" : "#ACA0E0"; } }
    }
    internal sealed class DesktopSession
    {
        public string Id { get; set; }
        public string Title { get; set; }
        public string DisplayTitle { get { return string.IsNullOrWhiteSpace(Title) ? Id : Title; } }
        public override string ToString(){return DisplayTitle;}
        public string AgentType { get; set; }
        public string Workspace { get; set; }
        public string ProjectKey { get; set; }
        public string ProjectLabel { get; set; }
        public string ProjectDescription { get; set; }
        public int Order { get; set; }
        public string Agent { get { return !string.IsNullOrEmpty(AgentType) ? AgentType : (Id ?? "").StartsWith("node:") ? "unknown" : (Id ?? "").Split(':')[0]; } }
        public string AgentLabel { get { return Agent=="unknown" ? "未标注 Agent 类型" : Agent; } }
        public string ProjectCaption { get { return string.IsNullOrEmpty(ProjectLabel) ? "未标注项目" : ProjectLabel; } }
        public SessionGroupLabel ProjectGroup { get { return new SessionGroupLabel(ProjectKey ?? "unassigned",ProjectCaption,ProjectDescription ?? Workspace ?? "未提供工作目录"); } }
        public SessionGroupLabel AgentGroup { get { return new SessionGroupLabel("agent:"+Agent,AgentLabel,""); } }
        public string ProjectSort { get { return ProjectGroup.Key; } }
        public string AgentSort { get { return (Agent=="zcode"?"0":Agent=="claude"?"1":Agent=="codex"?"2":Agent=="opencode"?"3":Agent=="unknown"?"9":"4")+Agent; } }
        public string Initial { get { return string.IsNullOrEmpty(Agent) || Agent=="unknown" ? "?" : Agent.Substring(0,1).ToUpperInvariant(); } }
    }
    internal sealed class BridgeFailure : Exception
    {
        internal readonly bool Uncertain;
        internal BridgeFailure(string message, bool uncertain) : base(message) { Uncertain = uncertain; }
    }
    internal sealed partial class ModernShell
    {
        private readonly Window window;
        private readonly Options options;
        private readonly string bridge;
        private readonly string node;
        private readonly DispatcherTimer timer = new DispatcherTimer();
        private List<DesktopMessage> messages = new List<DesktopMessage>();
        private List<DesktopSession> sessions = new List<DesktopSession>();
        private bool busy, sending, closed;
        private Config remote;
        private int generation;
        private string sendId;
        private string sendPayload;
        private bool uncertain;

        private readonly HashSet<Process> children = new HashSet<Process>();

        internal static int Run(Options opts)
        {
            try
            {
                var app = new System.Windows.Application();
                var shell = new ModernShell(opts);
                app.DispatcherUnhandledException += delegate(object sender, DispatcherUnhandledExceptionEventArgs e) {
                    shell.Status("操作未完成：" + Redact.Scrub(e.Exception.Message)); e.Handled = true;
                };
                app.Run(shell.window);
                return 0;
            }
            catch (Exception ex)
            {
                Program.Fail(opts.OutPath, 2, Redact.Scrub(ex.ToString()));
                if (!opts.UiSmoke) System.Windows.MessageBox.Show("OpenAcom 启动失败：\n" + Redact.Scrub(ex.Message), "OpenAcom");
                return 2;
            }
        }
        private T Find<T>(string name) where T : FrameworkElement { return (T)window.FindName(name); }
        private void Status(string text) { Find<TextBlock>("StatusText").Text = text; }
        internal static string State(string status)
        {
            switch(status) {
                case "accepted": case "sent": case "delivered": return "已投递";
                case "read": return "已读";
                case "refused": case "failed": return "投递失败";
                case "uncertain": return "需核实";
                case "queued": case "pending": return "等待投递";
                case "stored": return "仅入箱";
                case "delivering": return "投递中";
                case "deferred": return "等待条件就绪";
                case "expired": return "已过期";
                default: return status;
            }
        }
        private ModernShell(Options opts)
        {
            options = opts;
            using(var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("ModernShell.xaml"))
                window = (Window)XamlReader.Load(stream);
            bridge = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "bridge.js");
            node = FindNode();
            Find<TextBlock>("RuntimeInfo").Text = "Node.js：" + (node ?? "未找到，请安装 Node.js 22.5+ 后重新打开") + "\n本机消息：" + (Environment.GetEnvironmentVariable("AGENTRELAY_HOME") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".openacom")) + "\n默认路线：zcode → 桌面 CDP；其他 Agent → 会话适配器";
            if(!string.IsNullOrEmpty(opts.Url)) Find<TextBox>("HubUrl").Text = opts.Url;
            // Optional configuration never prevents the shell from opening.
            try { var cfg = Config.Discover(opts); Find<TextBox>("HubUrl").Text=cfg.Url; Find<PasswordBox>("HubToken").Password=cfg.Token; }
            catch(Exception) { }
            Find<Button>("NavOverview").Click += delegate { Navigate("Overview"); };
            Find<Button>("ViewSessionsButton").Click += delegate { Navigate("Sessions"); };
            Find<Button>("ViewMessagesButton").Click += delegate { Navigate("Messages"); };
            Find<Button>("NavMessages").Click += delegate { Navigate("Messages"); };
            Find<Button>("NavSessions").Click += delegate { Navigate("Sessions"); };
            Find<Button>("NavSettings").Click += delegate { Navigate("Settings"); };
            Find<Button>("RefreshButton").Click += async delegate { if(Find<FrameworkElement>("FleetPage").Visibility==Visibility.Visible && fleetMode=="overview")await RefreshFleet();else await Refresh(); };
            Find<Button>("ComposeButton").Click += delegate { retrySource=null;Find<CheckBox>("RetryVerified").Visibility=Visibility.Collapsed;OpenCompose(); };
            Find<Button>("CloseCompose").Click += delegate { if(!sending) Find<Border>("ComposeOverlay").Visibility=Visibility.Collapsed; };
            Find<Button>("SendButton").Click += async delegate { await Send(); };
            Find<Button>("AckButton").Click += async delegate { await Ack(); };
            Find<TextBox>("SearchBox").TextChanged += delegate { Filter(); };
            Find<ListBox>("MessagesList").SelectionChanged += delegate { Details(); };
            Find<Button>("ConnectButton").Click += async delegate { await Connect(); };
            Find<Button>("LocalButton").Click += async delegate { remote=null;generation++;SetConnection();await Refresh(); };
            timer.Interval=TimeSpan.FromSeconds(12);
            timer.Tick += async delegate { if(window.WindowState!=WindowState.Minimized && Find<Border>("ComposeOverlay").Visibility!=Visibility.Visible){if(Find<FrameworkElement>("FleetPage").Visibility==Visibility.Visible && fleetMode=="overview" && fleetConnection!=null)await RefreshFleet();else await Refresh();} };
            window.Closed += delegate { closed=true;timer.Stop();lock(children){foreach(var p in children){try{if(!p.HasExited)p.Kill();}catch{}}} };
            window.Loaded += async delegate {
                if(opts.UiSmoke){await Smoke();return;}
                if(node==null || !File.Exists(bridge)){Status("运行环境尚未就绪。打开连接设置查看诊断；窗口仍可正常使用。");Navigate("Settings");return;}
                await LoadPreferences();await Refresh();timer.Start();
            };
            InitializeControlCenter();InitializeFleet();InitializeSessionViews();Navigate("Overview");RenderDashboard();
            if(opts.UiSmoke){window.Left=-20000;window.Top=-20000;window.WindowStartupLocation=WindowStartupLocation.Manual;window.ShowInTaskbar=false;}
        }
        private static string FindNode()
        {
            string packaged=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"node.exe");
            if(File.Exists(packaged))return packaged;
            foreach(var folder in (Environment.GetEnvironmentVariable("PATH")??"").Split(';')) {
                try {string p=Path.Combine(folder.Trim('"'),"node.exe");if(File.Exists(p))return p;} catch { }
            }
            string standard=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"nodejs","node.exe");
            return File.Exists(standard)?standard:null;
        }
        private void Navigate(string page)
        {
            foreach(string p in new[]{"Overview","Messages","Sessions","Fleet","Watch","Controls","Settings"}) {
                Find<FrameworkElement>(p+"Page").Visibility=p==page?Visibility.Visible:Visibility.Collapsed;
                Find<Button>("Nav"+p).Background=(Brush)new BrushConverter().ConvertFromString(p==page?"#2D2843":"Transparent");
            }
            Find<TextBlock>("PageTitle").Text=page=="Fleet"?"分布式控制":page=="Watch"?"收件箱监听":page=="Controls"?"控制中心":page=="Overview"?"协作总览":page=="Messages"?"消息收件箱":page=="Sessions"?"会话与节点":"连接设置";
            Find<TextBlock>("PageSubtitle").Text=page=="Fleet"?"连接机器，管理节点，让消息跨越工作环境。":page=="Watch"?"后台监听，新消息到达时提醒你。":page=="Controls"?"消息、服务与配置，直接在这里操作。":page=="Overview"?"谁在交流，消息去了哪里，一眼看清。":page=="Messages"?"每条消息有记录，每次投递有去向。":page=="Sessions"?"左侧选会话，右侧查看内容与操作。":"先在本机开始，需要时再连接远端。";
        }
        private Dictionary<string,object> Request(string action)
        {
            var req=new Dictionary<string,object>{{"action",action}};
            if(action=="snapshot"){req["query"]=Find<TextBox>("SessionSearchBox").Text;req["limit"]=Find<TextBox>("SessionLimitBox").Text;}
            if(remote!=null){req["remote"]=true;req["url"]=remote.Url;req["token"]=remote.Token;}
            return req;
        }
        private async Task<Dictionary<string,object>> Execute(Dictionary<string,object> request)
        {
            if(node==null)throw new Exception("未找到 Node.js。请安装 Node.js 22.5+，或将 node.exe 放到程序目录。");
            if(!File.Exists(bridge))throw new Exception("缺少 bridge.js。请使用完整的 OpenAcom Desktop 文件夹。");
            string json=Json.Write(request);
            return await Task.Run(delegate {
                var info=new ProcessStartInfo(node,"\""+bridge+"\"") {UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8,WorkingDirectory=AppDomain.CurrentDomain.BaseDirectory};
                using(var p=new Process {StartInfo=info}) {
                    p.Start();lock(children){children.Add(p);}
                    try {
                        var output=p.StandardOutput.ReadToEndAsync();var error=p.StandardError.ReadToEndAsync();
                        byte[] bytes=Encoding.UTF8.GetBytes(json);p.StandardInput.BaseStream.Write(bytes,0,bytes.Length);p.StandardInput.Close();
                        if(!p.WaitForExit(request["action"].ToString()=="send"||request["action"].ToString().StartsWith("remote.")?75000:30000)){p.Kill();throw new Exception("操作超时。若已点击发送，请先查看 inbox 核实，勿重复发送。");}
                        Task.WaitAll(output,error);
                        Dictionary<string,object> envelope;
                        try{envelope=J.AsObject(Json.Parse(output.Result));}catch{throw new Exception("本机服务没有返回有效结果，请检查 Node.js 版本（需要 22.5+）。");}
                        if(envelope==null || !J.B(envelope,"ok"))throw new BridgeFailure(Redact.Scrub(envelope==null?"本机服务响应为空":J.S(envelope,"error")),envelope==null || J.B(envelope,"uncertain"));
                        return J.O(envelope,"result");
                    } finally {lock(children){children.Remove(p);}}
                }
            });
        }
        private async Task Refresh()
        {
            if(busy || closed)return;busy=true;Find<Button>("RefreshButton").IsEnabled=false;
            int epoch=generation;
            try {
                var data=await Execute(Request("snapshot"));if(closed || epoch!=generation)return;
                messages=(J.A(data,"messages")??new List<object>()).Select(item=>{
                    var r=J.AsObject(item);return new DesktopMessage{Id=J.S(r,"id"),Target=J.S(r,"to"),Sender=J.S(r,"from"),Preview=J.S(r,"text"),Status=J.S(r,"status"),RouteLabel=J.S(r,"route"),TimeLabel=J.Stamp(J.N(r,"time")),Detail=J.S(r,"detail")};
                }).ToList();
                sessions=(J.A(data,"sessions")??new List<object>()).Select((item,index)=>{var r=J.AsObject(item);return new DesktopSession{Id=J.S(r,"id"),Title=J.S(r,"title"),AgentType=J.S(r,"agent"),Workspace=J.S(r,"workspace"),ProjectKey=J.S(r,"projectKey"),ProjectLabel=J.S(r,"projectLabel"),ProjectDescription=J.S(r,"projectDescription"),Order=index};}).ToList();
                ApplySessionView();
                UpdateCounts();Filter();RenderDashboard();
                Status("已更新 " + DateTime.Now.ToString("HH:mm:ss") + "  ·  " + messages.Count + " 条消息  ·  " + sessions.Count + " 个会话" + (string.IsNullOrEmpty(J.S(data,"warning"))?"":"  · 会话扫描失败："+J.S(data,"warning")));
            } catch(Exception ex) {if(!closed)Status("连接未就绪："+Redact.Scrub(ex.Message));}
            finally {busy=false;if(!closed)Find<Button>("RefreshButton").IsEnabled=true;}
        }
        private void UpdateCounts(){Find<TextBlock>("CountAll").Text=messages.Count.ToString();Find<TextBlock>("CountDone").Text=messages.Count(m=>new[]{"accepted","sent","read","delivered"}.Contains(m.Status)).ToString();Find<TextBlock>("CountAttention").Text=messages.Count(m=>new[]{"refused","failed","uncertain"}.Contains(m.Status)).ToString();}
        private void Filter()
        {
            var list=Find<ListBox>("MessagesList");var selected=list.SelectedItem as DesktopMessage;
            string q=Find<TextBox>("SearchBox").Text.Trim();
            Find<TextBlock>("SearchHint").Visibility=string.IsNullOrEmpty(q)?Visibility.Visible:Visibility.Collapsed;
            var found=messages.Where(m=>string.IsNullOrEmpty(q)||(m.Sender+" "+m.Target+" "+m.Preview+" "+m.State+" "+m.Id).IndexOf(q,StringComparison.OrdinalIgnoreCase)>=0).ToList();
            list.ItemsSource=found;if(selected!=null)list.SelectedItem=found.FirstOrDefault(m=>m.Id==selected.Id);
            Find<StackPanel>("EmptyState").Visibility=found.Count==0?Visibility.Visible:Visibility.Collapsed;
            Find<TextBlock>("EmptyTitle").Text=string.IsNullOrEmpty(q)?"从第一条消息开始":"没有匹配的消息";
            Find<TextBlock>("EmptyBody").Text=string.IsNullOrEmpty(q)?"选择一个会话，把想说的发送给它。\n投递失败的消息也会留在这里。":"试试其他关键词，或清空搜索。";
        }
        private async void Details()
        {
            var row=Find<ListBox>("MessagesList").SelectedItem as DesktopMessage;
            Find<Button>("AckButton").IsEnabled=row!=null && row.Status!="read";
            Find<Button>("RetryButton").IsEnabled=row!=null && new[]{"stored","failed","refused","uncertain","pending"}.Contains(row.Status);
            Find<Button>("RemoteStatusButton").IsEnabled=row!=null && row.Target.StartsWith("node:");
            Find<Button>("HubRetryButton").IsEnabled=row!=null && row.Target.StartsWith("node:");
            Find<TextBlock>("DetailMeta").Text=row==null?"选择一条消息查看投递记录":row.State+" · "+row.RouteLabel+"\n\n来自 "+row.Sender+"\n发往 "+row.Target+"\n\n"+row.TimeLabel+"\n"+row.Id;
            Find<TextBox>("DetailBody").Text=row==null?"":row.Preview+(string.IsNullOrEmpty(row.Detail)?"":"\n\n投递说明\n"+row.Detail);
            if(row!=null && !options.UiSmoke) {try{var req=Request("message.get");req["id"]=row.Id;var result=await Execute(req);var selected=Find<ListBox>("MessagesList").SelectedItem as DesktopMessage;if(!closed && selected!=null && selected.Id==row.Id)Find<TextBox>("DetailBody").Text=J.S(result,"text")+(string.IsNullOrEmpty(row.Detail)?"":"\n\n"+row.Detail);}catch(Exception e){if(!closed)Status(Redact.Scrub(e.Message));}}
        }
        private void OpenCompose(bool retry=false){if(!retry){retrySource=null;Find<CheckBox>("RetryVerified").Visibility=Visibility.Collapsed;}ApplyComposeDefaults();Find<Border>("ComposeOverlay").Visibility=Visibility.Visible;Find<TextBox>("Recipient").Focus();}
        private async Task Send()
        {
            if(sending)return;
            string to=Find<TextBox>("Recipient").Text.Trim(),text=Find<TextBox>("MessageText").Text;
            if(string.IsNullOrWhiteSpace(to)||string.IsNullOrWhiteSpace(text)){Find<TextBlock>("SendStatus").Text="请填写收件地址和消息内容。";return;}
            string route=(string)((ComboBoxItem)Find<ComboBox>("RouteBox").SelectedItem).Tag;
            bool consent=Find<CheckBox>("ConsentBox").IsChecked==true;
            bool localDesktop=route=="desktopcdp"||route=="desktop"||(route=="auto"&&to.StartsWith("zcode:"));
            if(localDesktop&&!consent&&Environment.GetEnvironmentVariable("OPENACOM_DESKTOP_CONSENT")!="1"&&Environment.GetEnvironmentVariable("AGENTRELAY_DESKTOP_CONSENT")!="1") {Find<TextBlock>("SendStatus").Text="等待桌面提交确认：请勾选下方“允许本次消息在桌面中提交”，再点发送。";Find<CheckBox>("ConsentBox").Focus();return;}
            string payload=to+"\n"+text+"\n"+route+"\n"+consent+"\n"+(remote==null?"local":remote.Url)+"\n"+Find<TextBox>("SenderBox").Text+"\n"+Find<TextBox>("CdpPortBox").Text+"\n"+Find<TextBox>("CdpTargetBox").Text+"\n"+Find<TextBox>("TimeoutBox").Text+"\n"+Find<ComboBox>("ModeBox").SelectedIndex+"\n"+Find<CheckBox>("WaitBox").IsChecked+"\n"+Find<CheckBox>("NoSignatureBox").IsChecked;
            if(uncertain && payload==sendPayload){Find<TextBlock>("SendStatus").Text="上次投递结果不确定。请先在 inbox 核实，勿重复发送。";return;}
            if(payload!=sendPayload){sendId=Guid.NewGuid().ToString();sendPayload=payload;}
            foreach(string name in new[]{"Recipient","RecipientPicker","MessageText","RouteBox","ConsentBox","AdvancedSend","RetryVerified"}) Find<Control>(name).IsEnabled=false;
            sending=true;Find<Button>("SendButton").IsEnabled=false;Find<Button>("CloseCompose").IsEnabled=false;
            Find<Button>("FixCdpButton").Visibility=Visibility.Collapsed;
            Find<TextBlock>("SendStatus").Text="正在保存并投递…";
            try {
                var req=Request(retrySource==null?"send":"message.retry");req["to"]=to;req["text"]=text;req["route"]=route;req["consent"]=consent;req["id"]=sendId;
                req["from"]=Find<TextBox>("SenderBox").Text;req["cdpPort"]=Find<TextBox>("CdpPortBox").Text;req["cdpTargetId"]=Find<TextBox>("CdpTargetBox").Text;
                if(route!="mailbox")req["timeoutMs"]=Find<TextBox>("TimeoutBox").Text;
                req["wait"]=Find<CheckBox>("WaitBox").IsChecked==true;req["noSignature"]=Find<CheckBox>("NoSignatureBox").IsChecked==true;
                if(route=="relay" || (route=="auto" && to.StartsWith("node:")))req["mode"]=Convert.ToString(((ComboBoxItem)Find<ComboBox>("ModeBox").SelectedItem).Tag);
                if(retrySource!=null){req["originalId"]=retrySource;req["verified"]=Find<CheckBox>("RetryVerified").IsChecked==true;}
                var result=await Execute(req);if(closed)return;
                string state=J.S(result,"status");uncertain=state=="uncertain";
                if(state=="refused" || uncertain){ShowSendFailure(result);if(state=="refused")sendPayload=null;}
                else{Find<Border>("ComposeOverlay").Visibility=Visibility.Collapsed;Find<TextBox>("MessageText").Clear();Find<TextBlock>("SendStatus").Text="";sendPayload=null;uncertain=false;retrySource=null;Find<CheckBox>("RetryVerified").Visibility=Visibility.Collapsed;}
                await Refresh();
            }catch(Exception ex){uncertain=!(ex is BridgeFailure) || ((BridgeFailure)ex).Uncertain;if(!uncertain)sendPayload=null;if(!closed)Find<TextBlock>("SendStatus").Text=Redact.Scrub(ex.Message)+(uncertain?"\n请先刷新 inbox 核实投递结果。":"");}
            finally{sending=false;if(!closed){foreach(string name in new[]{"Recipient","RecipientPicker","MessageText","RouteBox","ConsentBox","AdvancedSend","RetryVerified"}) Find<Control>(name).IsEnabled=true;Find<Button>("SendButton").IsEnabled=true;Find<Button>("CloseCompose").IsEnabled=true;UpdateSendControls();}}
        }
        private async Task Ack()
        {
            var row=Find<ListBox>("MessagesList").SelectedItem as DesktopMessage;if(row==null)return;
            try{var req=Request("ack");req["id"]=row.Id;await Execute(req);await Refresh();}catch(Exception ex){Status(Redact.Scrub(ex.Message));}
        }
        private async Task Connect()
        {
            int epoch=generation;
            Find<Button>("ConnectButton").IsEnabled=false;
            try{
                var cfg=Config.Discover(new Options{Url=Find<TextBox>("HubUrl").Text.Trim(),Token=Find<PasswordBox>("HubToken").Password});
                Redact.SetSecret(cfg.Token);
                await Execute(new Dictionary<string,object>{{"action","snapshot"},{"remote",true},{"url",cfg.Url},{"token",cfg.Token}});
                if(closed || epoch!=generation)return;
                remote=cfg;generation++;SetConnection();Status("Hub 已连接。切换到会话与节点选择目标。");await Refresh();
            }catch(Exception ex){Status("连接失败："+Redact.Scrub(ex.Message));}
            finally{if(!closed)Find<Button>("ConnectButton").IsEnabled=true;}
        }
        private void SetConnection(){Find<TextBlock>("ConnectionBadge").Text=remote==null?"●  本机工作台":"●  Hub 已连接";Find<TextBlock>("ConnectionHint").Text=remote==null?"无需 Hub 即可使用":remote.Url;}
        private static string RenderedText(DependencyObject element)
        {
            var text=element as TextBlock;var result=text==null?"":text.Text;
            for(int i=0;i<VisualTreeHelper.GetChildrenCount(element);i++)result+=" "+RenderedText(VisualTreeHelper.GetChild(element,i));
            return result;
        }
        private void Shot(string file)
        {
            window.UpdateLayout();var visual=(FrameworkElement)window.Content;
            var bitmap=new RenderTargetBitmap((int)visual.ActualWidth,(int)visual.ActualHeight,96,96,PixelFormats.Pbgra32);bitmap.Render(visual);
            var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));using(var stream=File.Create(file))encoder.Save(stream);
        }
        private async Task Smoke()
        {
            try{
                await Task.Delay(200);
                var health=await Execute(new Dictionary<string,object>{{"action","health"}});
                bool bridgeReady=J.N(health,"protocol")==1;
                if(options.ShotPath!=null)Shot(options.ShotPath+"-empty.png");
                messages=new List<DesktopMessage>{
                    new DesktopMessage{Id="preview-1",Target="zcode:SDK 接入",Sender="desktop:operator",Preview="请检查默认 CDP 路线与消息状态，完成后回复。",Status="accepted",RouteLabel="desktopcdp",TimeLabel="刚刚"},
                    new DesktopMessage{Id="preview-2",Target="codex:接口联调",Sender="claude:review",Preview="接口类型已同步，可以开始联调。",Status="read",RouteLabel="session",TimeLabel="5 分钟前"},
                    new DesktopMessage{Id="preview-3",Target="node:studio/build",Sender="desktop:operator",Preview="构建任务已保存。等待远端连接恢复后核实状态。",Status="uncertain",RouteLabel="relay",TimeLabel="12 分钟前",Detail="远端连接中断，尚不能确认是否收到。不要自动重试。"}
                };
                sessions=new List<DesktopSession>{
                    new DesktopSession{Id="zcode:SDK 接入",Title="SDK 接入与桌面投递",Workspace="C:/Work/OpenAcom",ProjectKey="local:A",ProjectLabel="OpenAcom",ProjectDescription="C:/Work/OpenAcom",Order=0},
                    new DesktopSession{Id="codex:接口联调",Title="接口与类型联调",Workspace="C:/Work/OpenAcom",ProjectKey="local:A",ProjectLabel="OpenAcom",ProjectDescription="C:/Work/OpenAcom",Order=1},
                    new DesktopSession{Id="claude:review",Title="代码审查",Workspace="C:/Work/OrcaPod",ProjectKey="local:B",ProjectLabel="OrcaPod",ProjectDescription="C:/Work/OrcaPod",Order=2},
                    new DesktopSession{Id="zcode:实验分支",Title="实验环境的兼容检查",Workspace="D:/Experiments/OpenAcom",ProjectKey="local:C",ProjectLabel="OpenAcom",ProjectDescription="D:/Experiments/OpenAcom",Order=3}
                };
                UpdateCounts();Filter();RenderDashboard();
                if(options.ShotPath!=null)Shot(options.ShotPath+"-overview.png");
                var mapNode=Find<Canvas>("FlowMap").Children.OfType<Border>().First(b=>Convert.ToString(b.Tag)=="map-node:zcode");
                mapNode.RaiseEvent(new MouseButtonEventArgs(Mouse.PrimaryDevice,0,MouseButton.Left){RoutedEvent=UIElement.MouseLeftButtonUpEvent});
                bool nodeNavigation=Find<FrameworkElement>("MessagesPage").Visibility==Visibility.Visible && Find<ListBox>("MessagesList").Items.Count==1;
                var remoteNode=Find<Canvas>("FlowMap").Children.OfType<Border>().First(b=>Convert.ToString(b.Tag)=="map-node:node:studio");
                remoteNode.RaiseEvent(new MouseButtonEventArgs(Mouse.PrimaryDevice,0,MouseButton.Left){RoutedEvent=UIElement.MouseLeftButtonUpEvent});
                nodeNavigation=nodeNavigation && Find<ListBox>("MessagesList").Items.Count==1;
                Find<TextBox>("SearchBox").Clear();
                Navigate("Sessions");RestoreSessionView("project");
                var groupedView=(System.Windows.Data.ListCollectionView)Find<ListBox>("SessionsList").ItemsSource;
                bool projectGrouping=groupedView.Groups.Count==3 && groupedView.Groups.Cast<System.Windows.Data.CollectionViewGroup>().First(g=>((SessionGroupLabel)g.Name).Key=="local:A").Items.Count==2;
                Find<ListBox>("SessionsList").SelectedItem=sessions[1];
                Find<ComboBox>("SessionViewMode").SelectedIndex=1;
                var agentView=(System.Windows.Data.ListCollectionView)Find<ListBox>("SessionsList").ItemsSource;
                bool agentGrouping=agentView.Groups.Count==3 && agentView.Groups.Cast<System.Windows.Data.CollectionViewGroup>().First(g=>((SessionGroupLabel)g.Name).Key=="agent:zcode").ItemCount==2;
                bool selectionKept=((DesktopSession)Find<ListBox>("SessionsList").SelectedItem).Id=="codex:接口联调";
                if(options.ShotPath!=null)Shot(options.ShotPath+"-session-agents.png");
                RestoreSessionView("project");
                var stable=Find<ListBox>("SessionsList").ItemsSource;ApplySessionView();bool groupingStable=ReferenceEquals(stable,Find<ListBox>("SessionsList").ItemsSource);
                bool sessionGrouping=projectGrouping && agentGrouping && selectionKept && groupingStable;
                window.UpdateLayout();
                var leftPane=Find<Border>("SessionBrowser");var rightPane=Find<Border>("SessionDetailPane");
                bool sessionMasterDetail=leftPane.ActualWidth<=420 && rightPane.TranslatePoint(new Point(0,0),window).X>=leftPane.TranslatePoint(new Point(0,0),window).X+leftPane.ActualWidth && Find<TextBox>("SessionDetailAddress").Text=="codex:接口联调" && Find<TextBox>("SessionTranscript").Text.Contains("接口与类型联调");
                if(options.ShotPath!=null)Shot(options.ShotPath+"-sessions.png");
                var sessionCard=(Border)Find<System.Windows.Controls.Primitives.UniformGrid>("SessionCards").Children[0];
                sessionCard.RaiseEvent(new MouseButtonEventArgs(Mouse.PrimaryDevice,0,MouseButton.Left){RoutedEvent=UIElement.MouseLeftButtonUpEvent});
                bool sessionCompose=Find<TextBox>("Recipient").Text==sessions[0].Id && Find<Border>("ComposeOverlay").Visibility==Visibility.Visible;
                Find<Border>("ComposeOverlay").Visibility=Visibility.Collapsed;
                Navigate("Messages");Find<ListBox>("MessagesList").SelectedIndex=0;
                if(options.ShotPath!=null)Shot(options.ShotPath+"-messages.png");
                Find<TextBox>("SearchBox").Text="不匹配的搜索词";
                bool searchWorks=Find<ListBox>("MessagesList").Items.Count==0;
                Find<TextBox>("SearchBox").Clear();
                OpenCompose();Find<ComboBox>("RecipientPicker").SelectedItem=sessions[0];window.UpdateLayout();
                string pickerText=RenderedText(Find<ComboBox>("RecipientPicker"));
                bool recipientLabel=pickerText.Contains(sessions[0].DisplayTitle) && !pickerText.Contains("OpenAcom.Desktop.DesktopSession");
                ShowSendFailure(new Dictionary<string,object>{{"status","refused"},{"code","CONSENT_REQUIRED"}});
                bool consentHint=Find<TextBlock>("SendStatus").Text.Contains("等待桌面提交确认") && !Find<TextBlock>("SendStatus").Text.Contains("投递失败");
                Find<CheckBox>("ConsentBox").IsChecked=true;
                ShowSendFailure(new Dictionary<string,object>{{"status","refused"},{"code","DESKTOP_UNAVAILABLE"},{"detail","ECONNREFUSED 127.0.0.1:9222"}});
                bool cdpRecovery=Find<Button>("FixCdpButton").Visibility==Visibility.Visible && Find<TextBlock>("SendStatus").Text.Contains("ECONNREFUSED");
                if(options.ShotPath!=null)Shot(options.ShotPath+"-cdp-unavailable.png");
                Find<TextBlock>("SendStatus").Text="";Find<Button>("FixCdpButton").Visibility=Visibility.Collapsed;
                if(options.ShotPath!=null)Shot(options.ShotPath+"-compose.png");
                Find<Border>("ComposeOverlay").Visibility=Visibility.Collapsed;Navigate("Settings");
                if(options.ShotPath!=null)Shot(options.ShotPath+"-settings.png");
                Navigate("Controls");await BuildControlPanel("投递偏好");
                bool controlsReady=Find<WrapPanel>("ControlTabs").Children.Count==7;
                if(options.ShotPath!=null)Shot(options.ShotPath+"-controls.png");
                await BuildControlPanel("服务管理");if(options.ShotPath!=null)Shot(options.ShotPath+"-services.png");
                await BuildControlPanel("远端目标");controlsReady=controlsReady && controlForm.Children.OfType<Button>().Any(b=>Convert.ToString(b.Content)=="保存配置");
                Navigate("Messages");OpenCompose();Find<Expander>("AdvancedSend").IsExpanded=true;
                if(options.ShotPath!=null)Shot(options.ShotPath+"-advanced.png");
                Find<Border>("ComposeOverlay").Visibility=Visibility.Collapsed;
                fleetSnapshot=new Dictionary<string,object>{{"nodes",new List<object>{new Dictionary<string,object>{{"id","studio"},{"online",true},{"lastSeen",DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()},{"targets",new List<object>{"coder","reviewer"}}},new Dictionary<string,object>{{"id","build-box"},{"online",false},{"lastSeen",DateTimeOffset.UtcNow.AddHours(-1).ToUnixTimeMilliseconds()},{"targets",new List<object>{"build"}}}}},{"messages",new List<object>{new Dictionary<string,object>{{"id","preview-remote"},{"to","studio"},{"target","coder"},{"status","queued"},{"text","请检查接口与类型声明。"},{"retryEligible",true}}}},{"total",1L},{"alerts",new List<object>()},{"queueAvailable",true}};
                Navigate("Fleet");ShowFleetOverview();bool fleetReady=fleetBody.Children.OfType<WrapPanel>().Any(p=>p.Children.Count==2);
                if(options.ShotPath!=null)Shot(options.ShotPath+"-fleet.png");
                ShowSshPanel(true);if(options.ShotPath!=null)Shot(options.ShotPath+"-remote.png");
                Navigate("Watch");WatchServiceState("running");InboxArrived(new Dictionary<string,object>{{"count",1L},{"messages",new List<object>{new Dictionary<string,object>{{"id","preview-1"},{"from","pi:review"},{"to","desktop:operator"}}}}});
                bool watchReady=watchedCount==1 && Find<TextBlock>("WatchState").Text.Contains("后台监听");
                if(options.ShotPath!=null)Shot(options.ShotPath+"-watch.png");WatchServiceState("stopped");
                Program.Emit(options.OutPath,new Body().Set("ok",searchWorks && window.IsLoaded && bridgeReady && nodeNavigation && sessionCompose && controlsReady && fleetReady && watchReady && sessionGrouping && sessionMasterDetail && recipientLabel && consentHint && cdpRecovery).Set("recipientLabel",recipientLabel).Set("consentHint",consentHint).Set("cdpRecovery",cdpRecovery).Set("sessionMasterDetail",sessionMasterDetail).Set("sessionGrouping",sessionGrouping).Set("fleetReady",fleetReady).Set("watchReady",watchReady).Set("controlsReady",controlsReady).Set("graphNodes",mapNodeCount).Set("graphEdges",mapEdgeCount).Set("nodeNavigation",nodeNavigation).Set("sessionCompose",sessionCompose).Set("bridgeReady",bridgeReady).Set("windowLoaded",window.IsLoaded).Set("searchWorks",searchWorks).Set("messages",messages.Count).Set("defaultRoute",((ComboBoxItem)Find<ComboBox>("RouteBox").SelectedItem).Tag).Set("tokenRequiredForStartup",false).ToJson());
            }catch(Exception ex){Program.Fail(options.OutPath,2,ex.ToString());}
            finally{window.Close();}
        }
    }
}





