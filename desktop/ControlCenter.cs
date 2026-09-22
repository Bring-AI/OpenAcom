using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace OpenAcom.Desktop
{
    internal sealed class ConfigRow
    {
        public string Name {get;set;} public string Type {get;set;} public string Value {get;set;}
        public string Extra {get;set;} public string Secret {get;set;} public string TargetId {get;set;}
        public string Display {get{return Name+"  ·  "+Type;}}
    }
    internal sealed class DesktopService
    {
        internal Process Process; internal string State="启动中"; internal StringBuilder Log=new StringBuilder();
    }
    internal sealed partial class ModernShell
    {
        private Dictionary<string,object> preferences=new Dictionary<string,object>();
        private readonly Dictionary<string,DesktopService> services=new Dictionary<string,DesktopService>();
        private string retrySource;
        private StackPanel controlForm;
        private string panelName;
        private void InitializeControlCenter()
        {
            controlForm=Find<StackPanel>("ControlForm");
            foreach(string category in new[]{"投递偏好","服务管理","远端目标","自动化钩子","Agent 分组","会话操作","诊断与 CDP"}) {
                var key=category;var button=ControlButton(category);button.Margin=new Thickness(0,0,9,9);
                button.Click+=async delegate {await BuildControlPanel(key);};Find<WrapPanel>("ControlTabs").Children.Add(button);
            }
            Find<Button>("NavControls").Click+=async delegate {Navigate("Controls");if(panelName==null)await BuildControlPanel("投递偏好");};
            Find<ComboBox>("RouteBox").SelectionChanged+=delegate {UpdateSendControls();};
            Find<TextBox>("Recipient").TextChanged+=delegate {UpdateSendControls();};
            Find<PasswordBox>("HubToken").PasswordChanged+=delegate {Redact.SetSecret(Find<PasswordBox>("HubToken").Password);};
            Find<Button>("SaveConnectionButton").Click+=async delegate {await SavePreferences();};
            Find<Button>("CheckCdpTargetButton").Click+=async delegate {
                if(sending)return;string to=Find<TextBox>("Recipient").Text.Trim();
                Find<Button>("CheckCdpTargetButton").IsEnabled=false;Find<Button>("SendButton").IsEnabled=false;
                try{Find<TextBlock>("SendStatus").Text="正在定位目标会话并检查输入框…";var req=Request("cdp.target");req["to"]=to;req["port"]=Find<TextBox>("CdpPortBox").Text;req["targetId"]=Find<TextBox>("CdpTargetBox").Text;var r=await Execute(req);
                    if(!closed)Find<TextBlock>("SendStatus").Text=to==Find<TextBox>("Recipient").Text.Trim()?"已定位「"+J.S(r,"title")+"」，输入框可用。\n本次只检查，没有发送消息。":"收件地址已改变，请重新检查。";
                }catch(Exception e){if(!closed)Find<TextBlock>("SendStatus").Text="目标检查未通过：\n"+Redact.Scrub(e.Message);}
                finally{if(!closed){Find<Button>("CheckCdpTargetButton").IsEnabled=true;Find<Button>("SendButton").IsEnabled=true;}}
            };
            Find<Button>("FixCdpButton").Click+=async delegate {
                string port=Find<TextBox>("CdpPortBox").Text;
                Find<Border>("ComposeOverlay").Visibility=Visibility.Collapsed;Navigate("Controls");await BuildControlPanel("诊断与 CDP");
                var field=controlForm.Children.OfType<TextBox>().FirstOrDefault();if(field!=null)field.Text=port;
                ControlResult("当前消息仍保留在 inbox。先检查 CDP；未开启时，使用上方启动 / 重启按钮。重启前会确认。");
            };
            Find<Button>("RetryButton").Click+=async delegate {await PrepareRetry();};
            Find<Button>("RemoteStatusButton").Click+=async delegate {await InspectRemote();};
            Find<Button>("HubRetryButton").Click+=async delegate {await RetryHub();};
            Find<Button>("SearchSessionsButton").Click+=async delegate {await Refresh();};
            Find<Button>("ReadSessionButton").Click+=async delegate {await ReadSelectedSession();};
            Find<Button>("NewSessionButton").Click+=async delegate {Navigate("Controls");await BuildControlPanel("会话操作");};
            Find<ComboBox>("RecipientPicker").SelectionChanged+=delegate {var row=Find<ComboBox>("RecipientPicker").SelectedItem as DesktopSession;if(row!=null)Find<TextBox>("Recipient").Text=row.Id;};
            window.Closed+=delegate {foreach(var item in services.Values){try{item.Process.StandardInput.WriteLine("{\"action\":\"stop\"}");}catch{}}};
        }
        private static Button ControlButton(string text){return new Button{Content=text,Padding=new Thickness(15,9,15,9),Margin=new Thickness(0,0,10,0)};}
        private void ControlHeading(string title,string note)
        { controlForm.Children.Clear();controlForm.Children.Add(Label(title,20,"#E8EBF1"));var help=Label(note,12,"#929EB3");help.TextWrapping=TextWrapping.Wrap;help.Margin=new Thickness(0,10,0,18);controlForm.Children.Add(help); }
        private TextBox Field(string label,string value,bool multiline=false)
        {
            controlForm.Children.Add(Label(label,12,"#B9C4D5"));var box=new TextBox{Text=value??"",Margin=new Thickness(0,5,0,10),AcceptsReturn=multiline,TextWrapping=multiline?TextWrapping.Wrap:TextWrapping.NoWrap,MinHeight=multiline?85:36,MaxHeight=multiline?160:36,VerticalScrollBarVisibility=multiline?ScrollBarVisibility.Auto:ScrollBarVisibility.Hidden};controlForm.Children.Add(box);return box;
        }
        private ComboBox Choice(string label,string[] choices,string selected)
        {
            controlForm.Children.Add(Label(label,12,"#B9C4D5"));var box=new ComboBox{ItemsSource=choices,SelectedItem=choices.Contains(selected)?selected:choices[0],MinHeight=35,Margin=new Thickness(0,7,0,15)};controlForm.Children.Add(box);return box;
        }
        private PasswordBox SecretField(string label)
        {controlForm.Children.Add(Label(label,12,"#B9C4D5"));var box=new PasswordBox{Margin=new Thickness(0,7,0,15)};controlForm.Children.Add(box);return box;}
        private void ActionButton(string text,Func<Task> action)
        {
            var button=ControlButton(text);button.Margin=new Thickness(0,4,0,10);button.HorizontalAlignment=HorizontalAlignment.Left;
            button.Click+=async delegate {button.IsEnabled=false;try{await action();}catch(Exception e){ControlResult("操作未完成："+Redact.Scrub(e.Message));}finally{if(!closed)button.IsEnabled=true;}};
            controlForm.Children.Add(button);
        }
        private void ControlResult(string value){if(closed)return;Find<TextBox>("ControlOutput").Visibility=Visibility.Visible;Find<TextBox>("ControlOutput").Text=Redact.Scrub(value);}
        private string Pref(string key,string fallback){object value;return preferences.TryGetValue(key,out value)?Convert.ToString(value):fallback;}
        private async Task LoadPreferences()
        {
            try {
                preferences=await Execute(Request("preferences.get"))??new Dictionary<string,object>();
                RestoreSessionView(Pref("sessionView","project"));
                Find<TextBox>("HubUrl").Text=Pref("url",Find<TextBox>("HubUrl").Text);
                string encrypted=Pref("encryptedToken","");
                if(encrypted.Length>0){Find<PasswordBox>("HubToken").Password=Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(encrypted),null,DataProtectionScope.CurrentUser));Find<CheckBox>("RememberConnection").IsChecked=true;}
                int interval;if(int.TryParse(Pref("refreshSeconds","12"),out interval)&&interval>=3&&interval<=300)timer.Interval=TimeSpan.FromSeconds(interval);
            }catch(Exception e){Status("偏好未加载："+Redact.Scrub(e.Message));}
        }
        private async Task SavePreferences()
        {
            try {
                preferences["url"]=Find<TextBox>("HubUrl").Text.Trim();
                preferences["encryptedToken"]=Find<CheckBox>("RememberConnection").IsChecked==true?Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(Find<PasswordBox>("HubToken").Password),null,DataProtectionScope.CurrentUser)):"";
                var req=Request("preferences.save");req["preferences"]=new Dictionary<string,object>(preferences);await WriteDesktopPreferences(req);
                timer.Interval=TimeSpan.FromSeconds(int.Parse(Pref("refreshSeconds","12")));
                Status("设置已保存。新的消息将使用这些默认参数。");ControlResult("设置已保存；连接令牌使用 Windows 当前用户加密。");
            }catch(Exception e){Status("设置未保存："+Redact.Scrub(e.Message));ControlResult(e.Message);}
        }
        private async Task BuildControlPanel(string category)
        {
            panelName=category;Find<TextBox>("ControlOutput").Visibility=Visibility.Collapsed;
            if(category=="投递偏好") {
                ControlHeading(category,"设置新消息的默认参数；单条消息仍可在发送面板中覆盖。");
                var from=Field("发送方地址",Pref("from","desktop:operator"));
                var route=Choice("默认路线",new[]{"auto","desktopcdp","session","desktop","relay","mailbox"},Pref("route","auto"));
                var portBox=Field("ZCode CDP 端口",Pref("cdpPort","9222"));var timeout=Field("投递超时（毫秒，1000–300000）",Pref("timeoutMs","60000"));var interval=Field("自动刷新间隔（秒，3–300）",Pref("refreshSeconds","12"));
                ActionButton("保存投递偏好",async delegate {preferences["from"]=from.Text;preferences["route"]=route.SelectedItem;preferences["cdpPort"]=portBox.Text;preferences["timeoutMs"]=timeout.Text;preferences["refreshSeconds"]=interval.Text;await SavePreferences();});return;
            }
            if(category=="远端目标"||category=="自动化钩子"||category=="Agent 分组") {await ConfigEditor(category);return;}
            if(category=="服务管理") {ServiceEditor();return;}
            if(category=="会话操作") {
                ControlHeading(category,"创建新会话、读取记录或打开交互窗口。新建会话会提交下方消息。");
                var selected=new ComboBox{ItemsSource=sessions,DisplayMemberPath="Title",MinHeight=35,Margin=new Thickness(0,0,0,14)};controlForm.Children.Add(selected);
                var last=Field("读取最近几轮（1–100）","30");
                ActionButton("读取所选会话",async delegate {var row=selected.SelectedItem as DesktopSession;if(row==null)throw new Exception("请选择会话");await ShowSession(row.Id,int.Parse(last.Text));});
                var cwd=Field("工作目录（可留空）","");var body=Field("ZCode 新会话的首条消息","",true);
                ActionButton("创建 ZCode 会话",async delegate {var req=Request("session.new");req["text"]=body.Text;req["cwd"]=cwd.Text;var r=await Execute(req);ControlResult(Json.Write(r));await Refresh();});
                var executable=Field("终端程序",Environment.GetEnvironmentVariable("COMSPEC")??"cmd.exe");
                ActionButton("选择终端程序",delegate {var dialog=new Microsoft.Win32.OpenFileDialog{Filter="可执行程序|*.exe|所有文件|*.*"};if(dialog.ShowDialog(window)==true)executable.Text=dialog.FileName;return Task.FromResult(0);});
                var arguments=Field("程序参数（每行一个，可留空）","",true);var target=Field("受控终端目标名称","local-terminal");
                ActionButton("打开受控终端窗口",delegate {var args=new List<string>{CliPath(),"terminal","--name",target.Text,"--",executable.Text};args.AddRange(arguments.Text.Split(new[]{'\r','\n'},StringSplitOptions.RemoveEmptyEntries));LaunchInteractive(node,args,cwd.Text);ControlResult("终端已打开；它独立运行，关闭工作台不会结束该 Agent。");return Task.FromResult(0);});return;
            }
            ControlHeading("诊断与 CDP","检测连接、生成凭据、管理桌面 CDP。重启 ZCode 会另行确认，避免中断正在进行的工作。");
            ActionButton("检查运行环境",async delegate {ControlResult(Json.Write(await Execute(Request("diagnostics"))));});
            var cdp=Field("CDP 端口",Pref("cdpPort","9222"));
            ActionButton("检查 ZCode CDP",async delegate {var req=Request("cdp.probe");req["port"]=cdp.Text;ControlResult(Json.Write(await Execute(req)));});
            ActionButton("启动 / 重启 ZCode 并启用 CDP",async delegate {int port;if(!int.TryParse(cdp.Text,out port)||port<1||port>65535)throw new Exception("端口无效");
                string inspect=await RunHidden("powershell.exe",new List<string>{"-NoProfile","-ExecutionPolicy","Bypass","-File",ToolPath("start-zcode-cdp.ps1"),"-Inspect","-Port",port.ToString()});
                var desktopState=J.AsObject(Json.Parse(inspect));bool running=J.N(desktopState,"desktopCount")>0;
                if(running && MessageBox.Show(window,"这会关闭并重启 ZCode。请先保存正在进行的工作。现在重启？","启用桌面 CDP",MessageBoxButton.YesNo,MessageBoxImage.Question)!=MessageBoxResult.Yes)return;
                string script=ToolPath("start-zcode-cdp.ps1");var args=new List<string>{"-NoProfile","-ExecutionPolicy","Bypass","-File",script,"-Port",port.ToString()};if(running)args.Add("-Force");ControlResult(await RunHidden("powershell.exe",args));});
            ActionButton("生成 Hub 令牌并填入连接设置",async delegate {var r=await Execute(Request("token.generate"));Find<PasswordBox>("HubToken").Password=J.S(r,"token");ControlResult("新令牌已填入连接设置；不会自动写入服务或修改现有连接。");});
            ActionButton("打开数据目录",delegate {string home=Environment.GetEnvironmentVariable("AGENTRELAY_HOME")??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".openacom");Directory.CreateDirectory(home);Process.Start(new ProcessStartInfo("explorer.exe",Quote(home)){UseShellExecute=true});return Task.FromResult(0);});
        }
        private async Task ConfigEditor(string category)
        {
            string kind=category=="远端目标"?"targets":category=="自动化钩子"?"hooks":"groups";
            ControlHeading(category,kind=="targets"?"配置本节点公布的目标。终端地址和密钥来自受控终端描述文件；修改后重启节点服务生效。":kind=="hooks"?"在消息事件发生时运行你指定的命令。保存不会立即执行命令。":"group 行填写组名和成员（逗号分隔）；owner 行填写会话 ID、目录模式或 platform:agent，以及所有者。");
            var req=Request("config.get");req["kind"]=kind;Dictionary<string,object> loaded;
            try{loaded=await Execute(req);}catch(Exception e){ControlResult(e.Message);return;}
            var rows=new ObservableCollection<ConfigRow>((J.A(loaded,"rows")??new List<object>()).Select(o=>{var r=J.AsObject(o);return new ConfigRow{Name=J.S(r,"name"),Type=J.S(r,"type"),Value=J.S(r,"value"),Extra=J.S(r,"extra"),Secret=J.S(r,"secret"),TargetId=J.S(r,"targetId")};}));
            var list=new ListBox{ItemsSource=rows,DisplayMemberPath="Display",MaxHeight=135,Margin=new Thickness(0,0,0,15)};controlForm.Children.Add(list);
            ComboBox type=kind=="hooks"?null:Choice("类型",kind=="targets"?new[]{"zcode","terminal"}:new[]{"group","owner"},kind=="targets"?"zcode":"group");
            ComboBox eventBox=kind=="hooks"?Choice("触发事件",new[]{"message.created","message.sent","message.read","message.failed"},"message.created"):null;
            TextBox name=kind=="hooks"?null:Field("名称 / 匹配规则","");var value=Field(kind=="hooks"?"要执行的命令":kind=="targets"?"Session ID / 终端 socket":"成员（逗号分隔）/ 所有者","",kind=="hooks");
            TextBox extra=null,targetId=null;PasswordBox secret=null;
            if(kind=="targets"){extra=Field("CDP 端口（ZCode）","9222");targetId=Field("CDP 页面 ID（可留空）","");secret=SecretField("终端 secret（terminal 类型）");}
            if(kind=="targets") {
                var picker=new ComboBox{ItemsSource=sessions.Where(s=>s.Id.StartsWith("zcode:")).ToList(),DisplayMemberPath="Title",MinHeight=35,Margin=new Thickness(0,0,0,12)};controlForm.Children.Add(Label("从本机 ZCode 会话选择",12,"#B9C4D5"));controlForm.Children.Add(picker);
                picker.SelectionChanged+=delegate {var selected=picker.SelectedItem as DesktopSession;if(selected!=null){type.SelectedItem="zcode";value.Text=selected.Id.Substring(6);}};
                ActionButton("导入受控终端描述文件",async delegate {var dialog=new Microsoft.Win32.OpenFileDialog{Filter="终端描述文件|*.json"};if(dialog.ShowDialog(window)!=true)return;var import=Request("target.import");import["file"]=dialog.FileName;var result=await Execute(import);type.SelectedItem="terminal";name.Text=J.S(result,"name");value.Text=J.S(result,"socket");secret.Password=J.S(result,"secret");ControlResult("描述已读入表单；点击添加/更新，再保存配置。");});
            }
            list.SelectionChanged+=delegate {var r=list.SelectedItem as ConfigRow;if(r==null)return;if(name!=null)name.Text=r.Name;if(eventBox!=null)eventBox.SelectedItem=r.Name;if(type!=null)type.SelectedItem=r.Type;value.Text=r.Value;if(extra!=null)extra.Text=r.Extra;if(secret!=null)secret.Password=r.Secret??"";if(targetId!=null)targetId.Text=r.TargetId;};
            ActionButton("新建一行",delegate {list.SelectedItem=null;if(name!=null)name.Clear();value.Clear();if(secret!=null)secret.Clear();return Task.FromResult(0);});
            ActionButton("添加 / 更新此行",delegate {var old=list.SelectedItem as ConfigRow;var row=new ConfigRow{Name=name==null?Convert.ToString(eventBox.SelectedItem):name.Text.Trim(),Type=type==null?"hook":Convert.ToString(type.SelectedItem),Value=value.Text,Extra=extra==null?"":extra.Text,Secret=secret==null?"":secret.Password,TargetId=targetId==null?"":targetId.Text};if(old!=null)rows[rows.IndexOf(old)]=row;else rows.Add(row);list.SelectedItem=row;return Task.FromResult(0);});
            ActionButton("移除所选行",delegate {var selected=list.SelectedItem as ConfigRow;if(selected!=null)rows.Remove(selected);return Task.FromResult(0);});
            if(kind=="groups")ActionButton("停用分组隔离（保留备份）",async delegate {if(MessageBox.Show(window,"停用后，本机 MCP 将恢复默认可见范围。确认停用分组隔离？","停用分组隔离",MessageBoxButton.YesNo,MessageBoxImage.Question)!=MessageBoxResult.Yes)return;var r=await Execute(Request("groups.disable"));ControlResult("分组隔离已停用；备份："+J.S(r,"backup"));});
            ActionButton("保存配置",async delegate {var save=Request("config.save");save["kind"]=kind;save["rows"]=rows.Select(r=>(object)new Dictionary<string,object>{{"name",r.Name},{"type",r.Type},{"value",r.Value},{"extra",r.Extra},{"secret",r.Secret},{"targetId",r.TargetId}}).ToList();var result=await Execute(save);ControlResult("已保存："+J.S(result,"file"));});
        }
        private void ServiceEditor()
        {
            ControlHeading("服务管理","管理由此工作台启动的后台服务。Hub 与 HTTP 服务只监听本机；节点连接使用“连接设置”中的地址和令牌。关闭工作台会停止这些服务。");
            var kind=Choice("服务类型",new[]{"hub","node","mcp","web","opencode"},"hub");
            var port=Field("监听端口（节点服务不使用）","9330");var id=Field("节点 ID","desktop-node");var cwd=Field("OpenCode 工作目录（可留空）","");
            kind.SelectionChanged+=delegate {var k=Convert.ToString(kind.SelectedItem);port.Text=k=="mcp"?"9321":k=="web"?"9339":k=="opencode"?"4096":"9330";};
            ActionButton("启动服务",async delegate {string k=Convert.ToString(kind.SelectedItem);await StartService(k,port.Text,id.Text,cwd.Text);});
            ActionButton("停止所选服务",async delegate {await StopService(Convert.ToString(kind.SelectedItem));});
            ActionButton("查看运行状态与日志",delegate {ControlResult(string.Join("\n\n",services.Select(pair=>pair.Key+" · "+pair.Value.State+"\n"+pair.Value.Log)));return Task.FromResult(0);});
            ActionButton("打开 Web 管理页",delegate {string k=Convert.ToString(kind.SelectedItem);if(k!="web")throw new Exception("请选择 Web 服务类型；其他服务请查看状态与日志");int number;if(!int.TryParse(port.Text,out number)||number<1||number>65535)throw new Exception("端口无效");string url="http://127.0.0.1:"+number+(k=="mcp"?"/health":k=="hub"?"/nodes":"/");Process.Start(new ProcessStartInfo(url){UseShellExecute=true});return Task.FromResult(0);});
            ActionButton("复制 MCP 连接地址",delegate {if(Convert.ToString(kind.SelectedItem)!="mcp")throw new Exception("请先选择 MCP 服务类型");int number;if(!int.TryParse(port.Text,out number)||number<1||number>65535)throw new Exception("端口无效");Clipboard.SetText("http://127.0.0.1:"+number+"/mcp");ControlResult("MCP 地址已复制。");return Task.FromResult(0);});
            ActionButton("打开 OpenCode 交互界面",delegate {var args=new List<string>{CliPath(),"oc-attach"};if(cwd.Text.Trim().Length>0)args.Add(cwd.Text.Trim());args.Add("--port");args.Add(port.Text);LaunchInteractive(node,args,cwd.Text);return Task.FromResult(0);});
        }
        private async Task StartService(string kind,string port,string nodeId,string cwd,Dictionary<string,object> extra=null)
        {
            DesktopService existing;if(services.TryGetValue(kind,out existing)&&!existing.Process.HasExited)throw new Exception("该服务已在运行，请先停止");
            string script=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"service-host.js");
            var config=new Dictionary<string,object>{{"kind",kind},{"port",port},{"nodeId",nodeId},{"cwd",cwd},{"url",Find<TextBox>("HubUrl").Text.Trim()},{"token",Find<PasswordBox>("HubToken").Password}};
            if(extra!=null)foreach(var entry in extra)config[entry.Key]=entry.Value;
            Redact.SetSecret(Find<PasswordBox>("HubToken").Password);
            var process=new Process{StartInfo=new ProcessStartInfo(node,Quote(script)){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8},EnableRaisingEvents=true};
            var service=new DesktopService{Process=process};
            Action<string> log=text=>{if(text==null)return;lock(service.Log){service.Log.AppendLine(Redact.Scrub(text));if(service.Log.Length>6000)service.Log.Remove(0,service.Log.Length-6000);}if(!closed)window.Dispatcher.BeginInvoke(new Action(()=>{if(panelName=="服务管理")ControlResult(kind+" · "+service.State+"\n"+service.Log);}));};
            process.OutputDataReceived+=delegate(object s,DataReceivedEventArgs e){if(e.Data==null)return;try{var result=J.AsObject(Json.Parse(e.Data));if(J.Has(result,"state"))service.State=J.S(result,"state");if(J.S(result,"event")=="inbox"){if(!closed)window.Dispatcher.BeginInvoke(new Action(()=>InboxArrived(result)));return;}if(kind=="inbox"&&!closed)window.Dispatcher.BeginInvoke(new Action(()=>WatchServiceState(service.State)));}catch{}log(e.Data);};
            process.ErrorDataReceived+=delegate(object s,DataReceivedEventArgs e){log(e.Data);};
            process.Exited+=delegate {service.State="已停止";if(kind=="inbox"&&!closed)window.Dispatcher.BeginInvoke(new Action(()=>WatchServiceState("stopped")));log("进程已退出");};
            process.Start();services[kind]=service;process.BeginOutputReadLine();process.BeginErrorReadLine();byte[] bytes=Encoding.UTF8.GetBytes(Json.Write(config)+"\n");await process.StandardInput.BaseStream.WriteAsync(bytes,0,bytes.Length);await process.StandardInput.BaseStream.FlushAsync();ControlResult("启动请求已提交；下方显示真实服务状态。");
        }
        private async Task StopService(string kind)
        {
            DesktopService service;if(!services.TryGetValue(kind,out service)||service.Process.HasExited){ControlResult("此工作台没有运行中的 "+kind+" 服务。");return;}
            service.Process.StandardInput.WriteLine("{\"action\":\"stop\"}");
            bool exited=await Task.Run(()=>service.Process.WaitForExit(10000));if(!exited){ControlResult("服务正在结束当前操作。稍后再次检查状态。");return;}service.State="已停止";ControlResult(kind+" 已停止。");
        }
        private string CliPath(){string root=AppDomain.CurrentDomain.BaseDirectory;string path=Path.Combine(root,"bin","openacom.js");return File.Exists(path)?path:Path.GetFullPath(Path.Combine(root,"..","bin","openacom.js"));}
        private string ToolPath(string name){string root=AppDomain.CurrentDomain.BaseDirectory;string path=Path.Combine(root,"tools",name);return File.Exists(path)?path:Path.GetFullPath(Path.Combine(root,"..","tools",name));}
        private static string Quote(string value){if(value==null)return "\"\"";return "\""+System.Text.RegularExpressions.Regex.Replace(value,@"(\\*)\""",@"$1$1\""")+System.Text.RegularExpressions.Regex.Match(value,@"\\*$").Value+"\"";}
        private static void LaunchInteractive(string executable,List<string> args,string cwd)
        {Process.Start(new ProcessStartInfo(executable,string.Join(" ",args.Select(Quote))){UseShellExecute=true,WorkingDirectory=string.IsNullOrWhiteSpace(cwd)?Environment.CurrentDirectory:cwd});}
        private static async Task<string> RunHidden(string executable,List<string> args)
        {
            return await Task.Run(delegate {using(var p=Process.Start(new ProcessStartInfo(executable,string.Join(" ",args.Select(Quote))){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8})){var output=p.StandardOutput.ReadToEndAsync();var error=p.StandardError.ReadToEndAsync();if(!p.WaitForExit(30000)){p.Kill();throw new Exception("操作超时");}Task.WaitAll(output,error);if(p.ExitCode!=0)throw new Exception(output.Result+error.Result);return output.Result+error.Result;}});
        }
        private async Task ReadSelectedSession(){await LoadSelectedTranscript(true);}
        private async Task ShowSession(string address,int last=30){var req=Request("session.read");req["address"]=address;req["last"]=last;var r=await Execute(req);ShowDocument(address,J.S(r,"text"));}
        private void ShowDocument(string title,string text){var viewer=new Window{Owner=window,Title=title,Width=780,Height=610,WindowStartupLocation=WindowStartupLocation.CenterOwner,Background=Ink("#191D25"),Content=new TextBox{Text=text??"",IsReadOnly=true,AcceptsReturn=true,TextWrapping=TextWrapping.Wrap,VerticalScrollBarVisibility=ScrollBarVisibility.Auto,Background=Ink("#191D25"),Foreground=Ink("#D7DFED"),Padding=new Thickness(22),BorderThickness=new Thickness(0)}};viewer.Show();}
        private void ShowSendFailure(Dictionary<string,object> result)
        {
            string code=J.S(result,"code"),detail=J.S(result,"detail"),message;
            Find<Button>("FixCdpButton").Visibility=code=="DESKTOP_UNAVAILABLE"||code=="CDP_IDENTITY"?Visibility.Visible:Visibility.Collapsed;
            if(code=="CONSENT_REQUIRED")message="等待桌面提交确认：请勾选“允许本次消息在桌面中提交”。";
            else if(code=="DESKTOP_UNAVAILABLE")message="ZCode 的桌面 CDP 无法连接（127.0.0.1:"+Find<TextBox>("CdpPortBox").Text+"）。\n请先检查端口，未开启时需要重启 ZCode 并启用 CDP。";
            else if(code=="DESKTOP_NOT_LISTED"||code=="DESKTOP_WORKSPACE"||code=="DESKTOP_TARGET")message="尚未定位到目标会话，请点击“检查目标会话”。";
            else if(code=="DESKTOP_TITLE_MISMATCH")message="会话名称已改变，请刷新会话列表后再试。";
            else if(code=="INPUT_DRAFT")message="ZCode 有尚未提交的草稿，请先处理草稿，再投递。";
            else message=State(J.S(result,"status"))+" · "+code;
            Find<TextBlock>("SendStatus").Text=message+(string.IsNullOrEmpty(detail)?"":"\n\n具体原因："+detail)+"\n\n消息已保留在 inbox。";
        }
        private async Task PrepareRetry()
        {
            var row=Find<ListBox>("MessagesList").SelectedItem as DesktopMessage;if(row==null)return;
            try{var req=Request("message.get");req["id"]=row.Id;var r=await Execute(req);retrySource=row.Id;OpenCompose(true);Find<TextBox>("Recipient").Text=J.S(r,"to");Find<TextBox>("MessageText").Text=J.S(r,"text");SelectRoute(J.S(r,"route"));Find<CheckBox>("RetryVerified").IsChecked=false;Find<CheckBox>("RetryVerified").Visibility=row.Status=="uncertain"||row.Status=="pending"?Visibility.Visible:Visibility.Collapsed;Find<TextBlock>("SendStatus").Text="这是一次新的投递，原消息记录会保留。";sendPayload=null;uncertain=false;}catch(Exception e){Status(Redact.Scrub(e.Message));}
        }
        private async Task InspectRemote(){var row=Find<ListBox>("MessagesList").SelectedItem as DesktopMessage;if(row==null)return;try{var req=Request("message.remoteStatus");req["id"]=row.Id;req["url"]=Find<TextBox>("HubUrl").Text;req["token"]=Find<PasswordBox>("HubToken").Password;ShowDocument("远端投递状态",Json.Write(await Execute(req)));}catch(Exception e){Status(Redact.Scrub(e.Message));}}
        private async Task RetryHub()
        {
            var row=Find<ListBox>("MessagesList").SelectedItem as DesktopMessage;if(row==null)return;
            if(MessageBox.Show(window,"向 Hub 请求重新排队？Hub 会拒绝已送达或投递不确定的消息。", "远端重新排队",MessageBoxButton.YesNo,MessageBoxImage.Question)!=MessageBoxResult.Yes)return;
            try{var req=Request("message.hubRetry");req["id"]=row.Id;req["url"]=Find<TextBox>("HubUrl").Text;req["token"]=Find<PasswordBox>("HubToken").Password;ControlResult(Json.Write(await Execute(req)));Status("Hub 已接受重新排队请求。");}catch(Exception e){Status(Redact.Scrub(e.Message));}
        }
        private void SelectRoute(string route){foreach(ComboBoxItem item in Find<ComboBox>("RouteBox").Items)if(Convert.ToString(item.Tag)==route){Find<ComboBox>("RouteBox").SelectedItem=item;return;}Find<ComboBox>("RouteBox").SelectedIndex=0;}
        private void UpdateSendControls()
        {
            string route=Convert.ToString(((ComboBoxItem)Find<ComboBox>("RouteBox").SelectedItem).Tag);
            string to=Find<TextBox>("Recipient").Text;
            string effective=route=="auto"?(to.StartsWith("node:")?"relay":to.StartsWith("zcode:")?"desktopcdp":"session"):route;
            Find<CheckBox>("WaitBox").IsEnabled=effective=="session";if(effective!="session")Find<CheckBox>("WaitBox").IsChecked=false;
            Find<ComboBox>("ModeBox").IsEnabled=effective=="relay";
            Find<TextBox>("CdpPortBox").IsEnabled=effective=="desktopcdp";Find<TextBox>("CdpTargetBox").IsEnabled=effective=="desktopcdp";
            Find<TextBox>("TimeoutBox").IsEnabled=effective!="mailbox";
            Find<CheckBox>("ConsentBox").IsEnabled=new[]{"desktopcdp","desktop","relay"}.Contains(effective);
        }
        private void ApplyComposeDefaults(){Find<ComboBox>("RecipientPicker").ItemsSource=sessions;if(Find<TextBox>("MessageText").Text.Length==0 && retrySource==null){Find<TextBox>("SenderBox").Text=Pref("from","desktop:operator");Find<TextBox>("TimeoutBox").Text=Pref("timeoutMs","60000");Find<TextBox>("CdpPortBox").Text=Pref("cdpPort","9222");SelectRoute(Pref("route","auto"));}}
    }
}
