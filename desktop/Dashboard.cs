using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;

namespace OpenAcom.Desktop
{
    internal sealed partial class ModernShell
    {
        private int mapNodeCount, mapEdgeCount;
        private static Brush Ink(string color) { return (Brush)new BrushConverter().ConvertFromString(color); }
        private static TextBlock Label(string text, double size, string color)
        { return new TextBlock {Text=text, FontSize=size, Foreground=Ink(color), TextTrimming=TextTrimming.CharacterEllipsis}; }
        private static string Group(string address)
        {
            if(string.IsNullOrEmpty(address))return "未知";
            if(address.StartsWith("node:")){int slash=address.IndexOf('/');return slash<0?address:address.Substring(0,slash);}
            int colon=address.IndexOf(':');return colon<0?address:address.Substring(0,colon);
        }
        private static string Tint(string group)
        {
            if(group=="zcode")return "#B9A2F5";
            if(group=="codex")return "#88CDB8";
            if(group=="desktop")return "#96B9ED";
            if(group=="pi")return "#ECC695";
            if(group.StartsWith("node:"))return "#81C8D8";
            return "#DFA3BF";
        }
        private static bool IsDone(DesktopMessage m){return new[]{"accepted","sent","read","delivered"}.Contains(m.Status);}
        private static bool NeedsAttention(DesktopMessage m){return new[]{"refused","failed","uncertain"}.Contains(m.Status);}
        private static void Put(Canvas canvas, UIElement element, double x, double y){Canvas.SetLeft(element,x);Canvas.SetTop(element,y);canvas.Children.Add(element);}
        private void ShowMessage(DesktopMessage message)
        {
            Navigate("Messages");Find<TextBox>("SearchBox").Clear();Filter();Find<ListBox>("MessagesList").SelectedItem=message;Find<ListBox>("MessagesList").ScrollIntoView(message);
        }
        private void RenderDashboard()
        {
            RenderMap();RenderRing();RenderRoutes();RenderSessionCards();RenderActivity();
        }
        private void RenderMap()
        {
            var canvas=Find<Canvas>("FlowMap");canvas.Children.Clear();
            // Decorative grid has no activity semantics; every edge below comes from inbox records.
            for(int x=14;x<680;x+=26)for(int y=12;y<340;y+=26)
                Put(canvas,new Ellipse{Width=1.6,Height=1.6,Fill=Ink("#34394B"),Opacity=0.5},x,y);
            Put(canvas,new Ellipse{Width=430,Height=212,Stroke=Ink("#38384D"),StrokeThickness=1,StrokeDashArray=new DoubleCollection{3,7}},125,64);
            Put(canvas,new Ellipse{Width=300,Height=300,Stroke=Ink("#2E3244"),StrokeThickness=1},190,20);
            var observed=messages.SelectMany(m=>new[]{Group(m.Sender),Group(m.Target)}).Concat(sessions.Select(s=>Group(s.Id))).Distinct().ToList();
            var ranked=observed.OrderByDescending(g=>messages.Count(m=>Group(m.Target)==g || Group(m.Sender)==g)).ToList();
            bool aggregated=ranked.Count>6;
            var groups=ranked.Take(aggregated?5:6).ToList();if(aggregated)groups.Add("其他");
            Func<string,string> visible=g=>groups.Contains(g)?g:"其他";
            var positions=new Dictionary<string,Point>();
            for(int i=0;i<groups.Count;i++) {
                double angle=(-150+360.0*i/Math.Max(groups.Count,1))*Math.PI/180;
                positions[groups[i]]=new Point(340+245*Math.Cos(angle),164+110*Math.Sin(angle));
            }
            mapNodeCount=groups.Count;
            var edges=messages.GroupBy(m=>visible(Group(m.Sender))+"\n"+visible(Group(m.Target))).ToList();
            mapEdgeCount=edges.Count;
            foreach(var edge in edges) {
                var parts=edge.Key.Split('\n');if(!positions.ContainsKey(parts[0]) || !positions.ContainsKey(parts[1]))continue;
                var a=positions[parts[0]];var b=positions[parts[1]];
                int issue=edge.Count(NeedsAttention);string color=issue>0?"#D9B481":edge.Any(IsDone)?"#86CDB6":"#A99CCD";
                double dx=b.X-a.X,dy=b.Y-a.Y,length=Math.Sqrt(dx*dx+dy*dy);
                Point start,end,control;
                if(length<1){start=new Point(a.X-22,a.Y-28);end=new Point(a.X+22,a.Y-28);control=new Point(a.X,a.Y-94);}
                else{start=new Point(a.X+dx/length*49,a.Y+dy/length*29);end=new Point(b.X-dx/length*52,b.Y-dy/length*31);control=new Point((a.X+b.X)/2-dy/length*35,(a.Y+b.Y)/2+dx/length*35);}
                var figure=new PathFigure{StartPoint=start};figure.Segments.Add(new QuadraticBezierSegment(control,end,true));
                var path=new System.Windows.Shapes.Path{Data=new PathGeometry(new[]{figure}),Stroke=Ink(color),StrokeThickness=1.7+Math.Min(edge.Count(),6)*0.35,Opacity=0.75,Cursor=Cursors.Hand,ToolTip=parts[0]+" → "+parts[1]+" · "+edge.Count()+" 条消息"};
                var latest=edge.First();path.MouseLeftButtonUp+=delegate {ShowMessage(latest);};canvas.Children.Add(path);
                Vector direction=end-control;direction.Normalize();Vector normal=new Vector(-direction.Y,direction.X);
                canvas.Children.Add(new Polygon{Points=new PointCollection{end,end-direction*8+normal*3.5,end-direction*8-normal*3.5},Fill=Ink(color)});
                Point midpoint=new Point(start.X*0.25+control.X*0.5+end.X*0.25,start.Y*0.25+control.Y*0.5+end.Y*0.25);
                var count=new Border{Background=Ink("#25293A"),BorderBrush=Ink(color),BorderThickness=new Thickness(0.7),CornerRadius=new CornerRadius(9),Padding=new Thickness(7,2,7,2),Child=Label(edge.Count().ToString(),11,color),ToolTip=path.ToolTip,Cursor=Cursors.Hand};
                count.MouseLeftButtonUp+=delegate {ShowMessage(latest);};Put(canvas,count,midpoint.X-11,midpoint.Y-9);
            }
            var center=new Border{Width=86,Height=86,CornerRadius=new CornerRadius(43),Background=Ink("#262B40"),BorderBrush=Ink("#6E648D"),BorderThickness=new Thickness(1.5)};
            var core=new StackPanel{VerticalAlignment=VerticalAlignment.Center};var mark=Label("↗",29,"#C3B2EE");mark.HorizontalAlignment=HorizontalAlignment.Center;core.Children.Add(mark);
            var coreLabel=Label("inbox",11,"#AFB4C8");coreLabel.HorizontalAlignment=HorizontalAlignment.Center;core.Children.Add(coreLabel);center.Child=core;Put(canvas,center,297,121);
            foreach(var group in groups) {
                Point p=positions[group];string color=Tint(group);
                var panel=new StackPanel();
                var badge=new Border{Width=32,Height=32,CornerRadius=new CornerRadius(10),Background=Ink("#32354B"),HorizontalAlignment=HorizontalAlignment.Center};
                var glyph=Label(group.StartsWith("node:")?"⌘":group=="其他"?"+":group.Substring(0,1).ToUpperInvariant(),17,color);glyph.HorizontalAlignment=HorizontalAlignment.Center;glyph.VerticalAlignment=VerticalAlignment.Center;badge.Child=glyph;panel.Children.Add(badge);
                var title=Label(group.Replace("node:","↗ "),13,"#E4E7EF");title.HorizontalAlignment=HorizontalAlignment.Center;title.Margin=new Thickness(0,6,0,3);panel.Children.Add(title);
                int count=messages.Count(m=>visible(Group(m.Sender))==group || visible(Group(m.Target))==group);
                var subtitle=Label(count+" 条记录",10,color);subtitle.HorizontalAlignment=HorizontalAlignment.Center;panel.Children.Add(subtitle);
                var card=new Border{Width=104,Padding=new Thickness(8),CornerRadius=new CornerRadius(12),Background=Ink("#202637"),BorderBrush=Ink(color),BorderThickness=new Thickness(0.7),Child=panel,Tag="map-node:"+group,Cursor=Cursors.Hand,ToolTip=group+" · 查看相关消息"};
                string selectedGroup=group;card.MouseLeftButtonUp+=delegate {Navigate("Messages");Find<TextBox>("SearchBox").Text=selectedGroup=="其他"?"":selectedGroup.StartsWith("node:")?selectedGroup+"/":selectedGroup+":";};
                Put(canvas,card,p.X-52,p.Y-46);
            }
            Find<TextBlock>("MapCaption").Text=messages.Count==0?"尚无通信记录 · 会话发现后会显示在这里":observed.Count+" 个参与方 · "+edges.Count+" 组通信方向"+(aggregated?" · 合并显示其他参与方":"");
            if(groups.Count==0){var hint=Label("你的第一条消息，将点亮这张地图",13,"#8B91AA");hint.Width=400;hint.TextAlignment=TextAlignment.Center;Put(canvas,hint,140,236);}
        }
        private void RenderRing()
        {
            var canvas=Find<Canvas>("DeliveryRing");canvas.Children.Clear();
            Put(canvas,new Ellipse{Width=128,Height=128,Stroke=Ink("#2E3340"),StrokeThickness=14},41,19);
            int done=messages.Count(IsDone),attention=messages.Count(NeedsAttention),stored=messages.Count(m=>m.Status=="stored");
            int[] values={done,attention,messages.Count-done-attention-stored,stored};
            string[] labels={"已投递 / 已读","需要关注","待投递 / 其他","仅入箱"},colors={"#8DCEB7","#D9B481","#A89ADC","#6A91BC"};
            double angle=-90;
            for(int i=0;i<values.Length;i++) {
                if(values[i]==0 || messages.Count==0)continue;
                double sweep=values[i]*360.0/messages.Count;
                double gap=Math.Min(1,sweep/4);
                double begin=(angle+gap)*Math.PI/180,finish=(angle+sweep-gap)*Math.PI/180;
                var f=new PathFigure{StartPoint=new Point(105+64*Math.Cos(begin),83+64*Math.Sin(begin))};
                f.Segments.Add(new ArcSegment(new Point(105+64*Math.Cos(finish),83+64*Math.Sin(finish)),new Size(64,64),0,sweep-2*gap>180,SweepDirection.Clockwise,true));
                canvas.Children.Add(new System.Windows.Shapes.Path{Data=new PathGeometry(new[]{f}),Stroke=Ink(colors[i]),StrokeThickness=14,StrokeStartLineCap=PenLineCap.Round,StrokeEndLineCap=PenLineCap.Round,ToolTip=labels[i]+" "+values[i]});angle+=sweep;
            }
            var total=Label(messages.Count.ToString(),32,"#E5E8EF");total.Width=120;total.TextAlignment=TextAlignment.Center;Put(canvas,total,45,54);
            var note=Label("条消息",11,"#8C95A7");note.Width=120;note.TextAlignment=TextAlignment.Center;Put(canvas,note,45,99);
            var legend=Find<StackPanel>("DeliveryLegend");legend.Children.Clear();
            for(int i=0;i<labels.Length;i++) {
                var grid=new Grid{Margin=new Thickness(0,0,0,7)};var stack=new StackPanel{Orientation=Orientation.Horizontal};stack.Children.Add(new Ellipse{Width=7,Height=7,Fill=Ink(colors[i]),Margin=new Thickness(0,0,8,0)});stack.Children.Add(Label(labels[i],11,"#9DA6B7"));grid.Children.Add(stack);
                var count=Label(values[i].ToString(),11,"#D3D9E4");count.HorizontalAlignment=HorizontalAlignment.Right;grid.Children.Add(count);legend.Children.Add(grid);
            }
        }
        private void RenderRoutes()
        {
            var panel=Find<StackPanel>("RouteBars");panel.Children.Clear();
            var groups=messages.GroupBy(m=>m.RouteLabel??"未知").OrderByDescending(g=>g.Count()).Take(3).ToList();
            if(groups.Count==0){panel.Children.Add(Label("投递后显示路线分布",11,"#717D90"));return;}
            foreach(var group in groups) {
                var row=new Grid{Margin=new Thickness(0,0,0,9)};row.ColumnDefinitions.Add(new ColumnDefinition{Width=new GridLength(76)});row.ColumnDefinitions.Add(new ColumnDefinition());row.ColumnDefinitions.Add(new ColumnDefinition{Width=new GridLength(27)});
                row.Children.Add(Label(group.Key,10,"#929FB4"));
                var track=new Border{Height=5,Background=Ink("#303544"),CornerRadius=new CornerRadius(2),VerticalAlignment=VerticalAlignment.Center};Grid.SetColumn(track,1);row.Children.Add(track);
                var grid=new Grid();grid.ColumnDefinitions.Add(new ColumnDefinition{Width=new GridLength(group.Count(),GridUnitType.Star)});grid.ColumnDefinitions.Add(new ColumnDefinition{Width=new GridLength(Math.Max(0,messages.Count-group.Count()),GridUnitType.Star)});grid.Children.Add(new Border{Height=5,CornerRadius=new CornerRadius(2),Background=Ink("#AC9AD5"),VerticalAlignment=VerticalAlignment.Center});Grid.SetColumn(grid,1);row.Children.Add(grid);
                var count=Label(group.Count().ToString(),10,"#B8C2D4");count.HorizontalAlignment=HorizontalAlignment.Right;Grid.SetColumn(count,2);row.Children.Add(count);panel.Children.Add(row);
            }
        }
        private void RenderSessionCards()
        {
            var host=Find<System.Windows.Controls.Primitives.UniformGrid>("SessionCards");host.Children.Clear();
            foreach(var session in sessions.Take(3)) {
                string color=Tint(session.Agent);var stack=new StackPanel();
                var head=new Grid();var badge=new Border{Width=34,Height=34,CornerRadius=new CornerRadius(10),Background=Ink("#343248"),HorizontalAlignment=HorizontalAlignment.Left};var letter=Label(session.Initial,17,color);letter.HorizontalAlignment=HorizontalAlignment.Center;letter.VerticalAlignment=VerticalAlignment.Center;badge.Child=letter;head.Children.Add(badge);
                var label=Label(session.Agent,10,color);label.HorizontalAlignment=HorizontalAlignment.Right;head.Children.Add(label);stack.Children.Add(head);
                var title=Label(string.IsNullOrWhiteSpace(session.Title)?session.Id:session.Title,13,"#E0E5EE");title.FontWeight=FontWeights.SemiBold;title.Margin=new Thickness(0,14,0,8);stack.Children.Add(title);
                stack.Children.Add(Label("已发现会话  ·  点击发送 ↗",10,"#8794A8"));
                var card=new Border{Padding=new Thickness(17),Margin=new Thickness(0,0,12,0),CornerRadius=new CornerRadius(11),BorderBrush=Ink("#313541"),BorderThickness=new Thickness(1),Background=Ink("#1C202A"),Child=stack,Cursor=Cursors.Hand,ToolTip=session.Id};
                string address=session.Id;card.MouseLeftButtonUp+=delegate {OpenCompose();Find<TextBox>("Recipient").Text=address;};host.Children.Add(card);
            }
            if(sessions.Count==0) {
                host.Columns=1;
                var panel=new StackPanel{Orientation=Orientation.Horizontal};panel.Children.Add(Label("◎",27,"#9C8ABB"));var text=Label("等待发现会话  ·  启动 Agent 后刷新，也可以直接填写收件地址。",12,"#919CAF");text.Margin=new Thickness(18,7,0,0);panel.Children.Add(text);
                host.Children.Add(new Border{Padding=new Thickness(20),Margin=new Thickness(0,0,12,0),CornerRadius=new CornerRadius(10),Background=Ink("#1A1E28"),Child=panel});
            }else host.Columns=3;
        }
        private void RenderActivity()
        {
            var host=Find<StackPanel>("ActivityTrail");host.Children.Clear();
            foreach(var message in messages.Take(2)) {
                var row=new Grid{Margin=new Thickness(0,0,0,9),Cursor=Cursors.Hand};row.ColumnDefinitions.Add(new ColumnDefinition{Width=new GridLength(23)});row.ColumnDefinitions.Add(new ColumnDefinition());row.ColumnDefinitions.Add(new ColumnDefinition{Width=new GridLength(80)});
                var icon=new Border{Width=8,Height=8,CornerRadius=new CornerRadius(4),Background=Ink(message.StateBrush),HorizontalAlignment=HorizontalAlignment.Left};row.Children.Add(icon);
                var text=Label(Group(message.Sender)+"  →  "+Group(message.Target)+"     "+message.Preview.Replace('\n',' '),11,"#A4AFC0");Grid.SetColumn(text,1);row.Children.Add(text);
                var status=Label(message.State,10,message.StateBrush);status.HorizontalAlignment=HorizontalAlignment.Right;Grid.SetColumn(status,2);row.Children.Add(status);
                var selected=message;row.MouseLeftButtonUp+=delegate {ShowMessage(selected);};host.Children.Add(row);
            }
            if(messages.Count==0)host.Children.Add(Label("新的消息会在这里留下轨迹。",11,"#7E8A9E"));
        }
    }
}
